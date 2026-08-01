import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { domainFromUrl, isPrivateAddress, normalizeUrl } from "./url";

export interface ExtractedPage {
  title: string;
  description: string;
  text: string;
  metadata: Record<string, string>;
  lowConfidence: boolean;
  canonicalUrl: string;
  sourceDomain: string;
}

export const MAX_PAGE_BYTES = 2_000_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function validateUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS links are supported.");
  }
  if (url.username || url.password) throw new Error("Links containing credentials are not supported.");
  if (isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error("The link resolves to a private or unsafe network address.");
  }
}

export function resolveRedirect(current: URL, location: string): URL {
  const next = new URL(location, current);
  validateUrl(next);
  return next;
}

export function validatePageResponse(statusCode: number | undefined, headers: IncomingHttpHeaders): void {
  if ((statusCode ?? 500) < 200 || (statusCode ?? 500) >= 300) {
    throw new Error(`The source returned HTTP ${statusCode}.`);
  }
  const contentType = String(headers["content-type"] ?? "");
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
    throw new Error(`Unsupported link content type: ${contentType || "unknown"}.`);
  }
  if (Number(headers["content-length"] ?? 0) > MAX_PAGE_BYTES) {
    throw new Error("The page is too large to process safely.");
  }
}

function requestPinned(url: URL, address: { address: string; family: number }): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      headers: {
        "user-agent": "SockDrawer/0.1 (+personal knowledge archive)",
        accept: "text/html,application/xhtml+xml",
        "accept-encoding": "identity",
      },
      lookup: (_hostname, options, callback) => {
  if (typeof options === "object" && options?.all) {
    callback(null, [
      {
        address: address.address,
        family: address.family,
      },
    ]);
    return;
  }

  callback(null, address.address, address.family);
},
    }, resolve);
    request.setTimeout(12_000, () => request.destroy(new Error("The source timed out.")));
    request.on("error", reject);
    request.end();
  });
}

export async function readPage(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_PAGE_BYTES) {
      response.destroy();
      throw new Error("The page is too large to process safely.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function clean(value: string): string {
  return decodeEntities(value.replace(/\s+/g, " ").trim());
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? clean(match[1]) : null;
}

export function extractHtml(html: string, fallbackUrl: string): ExtractedPage {
  // ponytail: regex extraction is enough for MVP; add Readability/parser when real pages fail recall.
  const metadata: Record<string, string> = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = attribute(tag, "property") ?? attribute(tag, "name");
    const content = attribute(tag, "content");
    if (key && content) metadata[key.toLowerCase()] = content;
  }
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = metadata["og:title"] ?? (titleMatch ? clean(titleMatch[1]) : new URL(fallbackUrl).hostname);
  const description = metadata["og:description"] ?? metadata.description ?? "";
  const text = clean(html
    .replace(/<(script|style|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")).slice(0, 50_000);
  const canonicalUrl = normalizeUrl(fallbackUrl);
  return {
    title,
    description,
    text,
    metadata,
    lowConfidence: text.length < 180,
    canonicalUrl,
    sourceDomain: domainFromUrl(canonicalUrl) ?? new URL(canonicalUrl).hostname,
  };
}

export async function extractPage(urlString: string): Promise<ExtractedPage> {
  let url = new URL(normalizeUrl(urlString));
  let response: IncomingMessage | null = null;
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    validateUrl(url);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new Error("The link resolves to a private or unsafe network address.");
    }
    response = await requestPinned(url, addresses[0]);
    if (!REDIRECTS.has(response.statusCode ?? 0)) break;
    const location = response.headers.location;
    response.resume();
    if (!location) throw new Error("The source redirected without a location.");
    url = resolveRedirect(url, location);
  }
  if (!response) throw new Error("The source could not be fetched.");
  if (REDIRECTS.has(response.statusCode ?? 0)) {
    response.destroy();
    throw new Error("The source redirected too many times.");
  }
  try {
    validatePageResponse(response.statusCode, response.headers);
  } catch (error) {
    response.destroy();
    throw error;
  }
  const html = await readPage(response);
  return extractHtml(html, url.toString());
}
