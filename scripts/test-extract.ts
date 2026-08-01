import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { POST } from "../src/app/api/extract/route";
import {
  extractHtml,
  extractPage,
  MAX_PAGE_BYTES,
  readPage,
  resolveRedirect,
  validatePageResponse,
} from "../src/lib/extract";

const originalKey = process.env.MEMORIA_ACCESS_KEY;
const originalOrigin = process.env.MEMORIA_EXTRACTOR_ORIGIN;
const originalFetch = globalThis.fetch;

async function main() {
  try {
    process.env.MEMORIA_EXTRACTOR_ORIGIN = "https://reader.example";
    let proxiedKey = "";
    globalThis.fetch = async (_input, init) => {
      proxiedKey = new Headers(init?.headers).get("x-memoria-key") ?? "";
      return Response.json({ title: "Proxied", content: "Reader content" });
    };
    const proxied = await POST(new Request("https://sockdrawer.example/api/extract", {
      method: "POST",
      headers: { "content-type": "application/json", "x-memoria-key": "phone-key" },
      body: JSON.stringify({ url: "https://example.com" }),
    }));
    assert.equal(proxied.status, 200);
    assert.equal(proxiedKey, "phone-key");
    assert.match(proxied.headers.get("cache-control") ?? "", /no-store/);

    delete process.env.MEMORIA_EXTRACTOR_ORIGIN;
    globalThis.fetch = originalFetch;
    delete process.env.MEMORIA_ACCESS_KEY;
    const unconfigured = await POST(new Request("http://localhost/api/extract", { method: "POST" }));
    assert.equal(unconfigured.status, 503);
    assert.match(unconfigured.headers.get("cache-control") ?? "", /no-store/);

    process.env.MEMORIA_ACCESS_KEY = "test-key";
    const unauthorized = await POST(new Request("http://localhost/api/extract", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com" }),
    }));
    assert.equal(unauthorized.status, 401);

    const privateUrl = await POST(new Request("http://localhost/api/extract", {
      method: "POST",
      headers: { "content-type": "application/json", "x-memoria-key": "test-key" },
      body: JSON.stringify({ url: "http://127.0.0.1/private" }),
    }));
    assert.equal(privateUrl.status, 422);
    assert.match((await privateUrl.json() as { error: string }).error, /private|unsafe/i);

    await assert.rejects(extractPage("https://user:secret@example.com"), /credentials/i);
    assert.throws(() => resolveRedirect(new URL("https://example.com"), "file:///secret"), /HTTP and HTTPS/i);
    assert.throws(() => resolveRedirect(new URL("https://example.com"), "http://127.0.0.1"), /private|unsafe/i);
    assert.throws(
      () => validatePageResponse(200, { "content-type": "application/pdf" }),
      /unsupported/i,
    );
    assert.throws(
      () => validatePageResponse(200, { "content-type": "text/html", "content-length": String(MAX_PAGE_BYTES + 1) }),
      /too large/i,
    );

    const extracted = extractHtml(
      "<title>Example &amp; Test</title><script>ignore()</script><main>Hello useful world.</main>",
      "https://www.example.com/article/?utm_source=test#part",
    );
    assert.equal(extracted.title, "Example & Test");
    assert.equal(extracted.canonicalUrl, "https://example.com/article");
    assert.equal(extracted.sourceDomain, "example.com");
    assert.doesNotMatch(extracted.text, /ignore/);

    const oversized = Readable.from([Buffer.alloc(MAX_PAGE_BYTES + 1)]) as unknown as Parameters<typeof readPage>[0];
    await assert.rejects(readPage(oversized), /too large/i);

    console.log("Extractor tests passed");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.MEMORIA_ACCESS_KEY;
    else process.env.MEMORIA_ACCESS_KEY = originalKey;
    if (originalOrigin === undefined) delete process.env.MEMORIA_EXTRACTOR_ORIGIN;
    else process.env.MEMORIA_EXTRACTOR_ORIGIN = originalOrigin;
  }
}

void main();
