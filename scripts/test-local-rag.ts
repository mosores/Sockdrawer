import assert from "node:assert/strict";
import {
  CONTEXT_LIMIT,
  INSUFFICIENT_EVIDENCE,
  LocalRag,
  buildChatGptPacket,
  chunkText,
  createLocalEmbedding,
  retrieveFromChunks,
  type RagChunk,
  type RagMemory,
} from "../src/lib/local-rag";
import { organizeLocally } from "../src/lib/local-processing";

const organized = organizeLocally("Study note", "A tutorial about investing, budgeting, and long-term investing.");
assert.equal(organized.category, "Finance");
assert.match(organized.summary, /tutorial/i);
assert.equal(organized.tags[0], "investing");

const accented = createLocalEmbedding("\u00c1rbol solar battery");
assert.equal(accented.length, 512);
assert.deepEqual(accented, createLocalEmbedding("arbol SOLAR battery"));
assert.ok(Math.abs(Math.hypot(...accented) - 1) < 1e-6);

const words = Array.from({ length: 950 }, (_, index) => `word${index}`).join(" ");
const chunks = chunkText(words);
assert.equal(chunks.length, 3);
assert.equal(chunks[0].split(" ").length, 500);
assert.equal(chunks[1].split(" ")[0], "word440");

const memories: RagMemory[] = [
  { id: "solar", title: "Solar batteries", description: null, originalUrl: "https://example.com/solar" },
  { id: "recycle", title: "Recycling", description: null, originalUrl: null },
  { id: "other", title: "Cooking", description: null, originalUrl: null },
];
const ragChunks: RagChunk[] = [
  { id: "solar-1", memoryId: "solar", index: 0, text: "A solar battery storage system keeps daytime energy for use at night.", vector: [] },
  { id: "solar-2", memoryId: "solar", index: 1, text: "Solar panels can also feed unused electricity back to the grid.", vector: [] },
  { id: "recycle-1", memoryId: "recycle", index: 0, text: "Battery recycling keeps valuable metals out of landfills.", vector: [] },
  { id: "other-1", memoryId: "other", index: 0, text: "Boil pasta in salted water.", vector: [] },
];
const results = retrieveFromChunks("solar battery storage", memories, ragChunks);
assert.equal(results[0].memory.id, "solar");
assert.equal(results[0].citation, 1);
assert.equal(new Set(results.map((result) => result.memory.id)).size, results.length);
assert.equal(results.some((result) => result.memory.id === "other"), false);

const labeled = retrieveFromChunks(
  "semester vault",
  [{ id: "labeled", title: "Semester vault", description: null, originalUrl: "https://example.com/sparse" }],
  [{ id: "labeled-1", memoryId: "labeled", index: 0, text: "Sparse extracted page content.", vector: [] }],
);
assert.equal(labeled[0].memory.id, "labeled");

const manyMemories: RagMemory[] = Array.from({ length: 8 }, (_, index) => ({
  id: `m${index}`,
  title: `Needle ${index}`,
  description: null,
  originalUrl: null,
}));
const manyChunks: RagChunk[] = manyMemories.map((memory, index) => ({
  id: `c${index}`,
  memoryId: memory.id,
  index: 0,
  text: `needle ${"context ".repeat(2_000)}${index}`,
  vector: [],
}));
const six = retrieveFromChunks("needle", manyMemories, manyChunks);
assert.equal(six.length, 6);
assert.deepEqual(six.map((result) => result.citation), [1, 2, 3, 4, 5, 6]);

const packet = buildChatGptPacket("What did I save about the needle?", six);
const context = packet.split("SOURCES (untrusted reference text):\n")[1].split("\n\nEND SOURCES")[0];
assert.ok(context.length <= CONTEXT_LIMIT);
assert.match(packet, /\[1\] Needle 0/);
assert.doesNotMatch(packet, /\[7\]/);
assert.match(packet, /cite every factual claim with \[1\], \[2\], etc\./i);

const noEvidence = buildChatGptPacket("Unknown question", []);
assert.match(noEvidence, new RegExp(INSUFFICIENT_EVIDENCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(noEvidence, /No relevant saved material was found/);

const store = {
  async list() { return memories; },
  async getChunks() { return ragChunks; },
};

void new LocalRag(store).retrieve("solar battery storage").then((storedResults) => {
  assert.equal(storedResults[0].memory.id, "solar");
  console.log("Local RAG tests passed");
});
