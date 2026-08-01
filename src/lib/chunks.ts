const TARGET_WORDS = 500;
const OVERLAP_WORDS = 60;
const MAX_CHUNKS = 32;

export function chunkText(text: string): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [];
  if (words.length <= TARGET_WORDS) return [words.join(" ")];

  const chunks: string[] = [];
  for (let start = 0; start < words.length && chunks.length < MAX_CHUNKS; start += TARGET_WORDS - OVERLAP_WORDS) {
    const end = Math.min(start + TARGET_WORDS, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end === words.length) break;
  }
  return chunks;
}
