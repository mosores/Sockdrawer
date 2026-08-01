import { createHash } from "node:crypto";
import { isIP } from "node:net";

const TRACKING_KEYS = new Set([
  "fbclid", "gclid", "igshid", "mc_cid", "mc_eid", "ref", "ref_src", "si",
]);

export function looksLikeUrl(input: string): boolean {
  try {
    const url = new URL(input.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS links are supported.");
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_KEYS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

export function hashContent(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function isPrivateAddress(address: string): boolean {
  if (!address || typeof address !== "string") return true;
  const normalized = address.toLowerCase().split("%")[0];
  if (!isIP(normalized)) return false;
  if (isIP(normalized) === 6) {
    const dotted = normalized.match(/(?:\d{1,3}\.){3}\d{1,3}$/)?.[0];
    if (dotted) return isPrivateAddress(dotted);
    const mapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
    return normalized === "::" || normalized === "::1" ||
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xff00) === 0xff00 ||
      normalized.startsWith("100:") ||
      normalized.startsWith("2001:db8:");
  }
  const [a, b] = normalized.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0);
}

export function domainFromUrl(input: string | null): string | null {
  if (!input) return null;
  try { return new URL(input).hostname.replace(/^www\./, ""); } catch { return null; }
}
