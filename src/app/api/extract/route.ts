import { NextResponse } from "next/server";
import { authorize } from "@/lib/auth";
import { extractPage } from "@/lib/extract";
import { normalizeUrl } from "@/lib/url";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const MAX_PROXY_BODY_BYTES = 16_384;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

async function proxyToVercel(request: Request, origin: string): Promise<Response> {
  const target = new URL("/api/extract", origin);
  if (target.protocol !== "https:" || target.username || target.password || target.origin === new URL(request.url).origin) {
    return json({ error: "MEMORIA_EXTRACTOR_ORIGIN is invalid." }, 503);
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_PROXY_BODY_BYTES) return json({ error: "The request is too large." }, 413);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 13_000);
  const response = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-memoria-key": request.headers.get("x-memoria-key") ?? "",
    },
    body,
    cache: "no-store",
    redirect: "error",
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
      ...NO_STORE,
    },
  });
}

export async function POST(request: Request) {
  const extractorOrigin = process.env.MEMORIA_EXTRACTOR_ORIGIN?.trim();
  if (extractorOrigin) {
    try { return await proxyToVercel(request, extractorOrigin); }
    catch { return json({ error: "The link reader is unavailable." }, 502); }
  }
  if (!process.env.MEMORIA_ACCESS_KEY) {
    return json({ error: "MEMORIA_ACCESS_KEY is not configured." }, 503);
  }
  const denied = authorize(request);
  if (denied) {
    denied.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
    return denied;
  }

  try {
    const body: unknown = await request.json();
    const url = typeof body === "object" && body !== null && "url" in body
      ? (body as { url?: unknown }).url
      : null;
    if (typeof url !== "string" || !url.trim() || url.length > 2_048) {
      return json({ error: "A valid URL is required." }, 400);
    }

    const page = await extractPage(normalizeUrl(url));
    return json({
      title: page.title,
      content: page.text,
      sourceDomain: page.sourceDomain,
      canonicalUrl: page.canonicalUrl,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "The page could not be extracted." }, 422);
  }
}
