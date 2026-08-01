import assert from "node:assert/strict";
import { extractLocalFile, MAX_LOCAL_FILE_BYTES } from "../src/lib/local-file-extract";
import { assertSafeLocalPath, formatLocalArchive, normalizeLocalUrl, parseLocalBackup, type LocalBackup, type LocalMemory } from "../src/lib/local-memory";

const now = "2026-07-22T12:00:00.000Z";
const memory: LocalMemory = {
  id: "11111111-1111-4111-8111-111111111111",
  clientRequestId: "request-11111111",
  type: "note",
  rawInput: "A note about local retrieval",
  originalUrl: null,
  normalizedUrl: null,
  title: "Local note",
  description: "Saved on this phone",
  category: "Learning",
  tags: ["local", "rag"],
  sourceDomain: null,
  processingStatus: "ready",
  processingError: null,
  createdAt: now,
  updatedAt: now,
  content: "A note about local retrieval",
  archivePath: "sockdrawer/2026/07/11111111-1111-4111-8111-111111111111.txt",
  originalFilePath: null,
  originalFilename: null,
  mimeType: null,
  size: 28,
  dedupeKey: "a".repeat(64),
};
const archive = formatLocalArchive(memory);
assert.match(archive, /^Title: Local note/m);
const backup: LocalBackup = {
  schema: "sockdrawer-phone-local",
  version: 1,
  exportedAt: now,
  memories: [memory],
  chunks: [{ id: `${memory.id}:0`, memoryId: memory.id, index: 0, text: memory.content, vector: [] }],
  settings: [],
  files: [{ path: memory.archivePath, mimeType: "text/plain", size: archive.length, base64: btoa(archive) }],
};

assert.equal(assertSafeLocalPath(memory.archivePath), memory.archivePath);
assert.equal(normalizeLocalUrl("https://www.example.com/path/?utm_source=x&b=2&a=1#top"), "https://example.com/path?a=1&b=2");
assert.throws(() => assertSafeLocalPath("sockdrawer/2026/07/../../secret"));
assert.throws(() => assertSafeLocalPath("sockdrawer\\2026\\07\\secret"));
assert.deepEqual(parseLocalBackup(JSON.stringify(backup)), backup);
assert.equal(parseLocalBackup(JSON.stringify(backup)).memories[0].title, "Local note");
assert.throws(() => parseLocalBackup(JSON.stringify({ ...backup, version: 2 })));
assert.throws(() => parseLocalBackup(JSON.stringify({ ...backup, files: [{ ...backup.files[0], path: "sockdrawer/2026/07/../secret" }] })));
assert.throws(() => parseLocalBackup(JSON.stringify({ ...backup, files: [{ ...backup.files[0], size: 1 }] })));

const binaryMemory: LocalMemory = {
  ...memory,
  id: "22222222-2222-4222-8222-222222222222",
  clientRequestId: "request-22222222",
  type: "document",
  rawInput: "sample.bin",
  title: "Binary sample",
  content: "sample.bin",
  archivePath: "sockdrawer/2026/07/22222222-2222-4222-8222-222222222222.txt",
  originalFilePath: "sockdrawer/2026/07/22222222-2222-4222-8222-222222222222--sample.bin",
  originalFilename: "sample.bin",
  mimeType: "application/octet-stream",
  size: 4,
  dedupeKey: "b".repeat(64),
};
const binaryArchive = formatLocalArchive(binaryMemory);
const withBinary: LocalBackup = {
  ...backup,
  memories: [memory, binaryMemory],
  chunks: [...backup.chunks, { id: binaryMemory.id + ":0", memoryId: binaryMemory.id, index: 0, text: binaryMemory.content, vector: [] }],
  files: [
    ...backup.files,
    { path: binaryMemory.archivePath, mimeType: "text/plain", size: binaryArchive.length, base64: btoa(binaryArchive) },
    { path: binaryMemory.originalFilePath!, mimeType: binaryMemory.mimeType!, size: 4, base64: btoa("\u0000\u0001\u0002\u00ff") },
  ],
};
assert.deepEqual(parseLocalBackup(JSON.stringify(withBinary)), withBinary);
assert.throws(() => parseLocalBackup(JSON.stringify({ ...withBinary, memories: [{ ...memory, sourceDomain: { unsafe: true } }, binaryMemory] })));
assert.throws(() => parseLocalBackup(JSON.stringify({ ...withBinary, files: withBinary.files.map((file, index) => index === 2 ? { ...file, mimeType: "not-a-mime" } : file) })));

function textPdf(text: string): File {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new File([body], "selectable.pdf", { type: "application/pdf" });
}

void (async () => {
  const text = await extractLocalFile(new File(["alpha\r\nbeta\u0000"], "notes.md", { type: "text/markdown" }));
  assert.equal(text.text, "alpha\nbeta");
  assert.equal(text.supported, true);
  const csv = await extractLocalFile(new File(["name,value\nalpha,1"], "data.csv", { type: "text/csv" }));
  assert.match(csv.text, /alpha,1/);
  const binary = await extractLocalFile(new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" }));
  assert.equal(binary.supported, false);
  const pdf = await extractLocalFile(textPdf("SockDrawer PDF text"));
  assert.match(pdf.text, /SockDrawer PDF text/);
  await assert.rejects(extractLocalFile(new File([new Uint8Array(MAX_LOCAL_FILE_BYTES + 1)], "huge.txt", { type: "text/plain" })));
  console.log("Phone-local storage validation tests passed");
})();
