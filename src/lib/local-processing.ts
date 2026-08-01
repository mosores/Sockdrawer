const STOP_WORDS = new Set([
  "about", "after", "also", "and", "are", "como", "con", "del", "desde", "esta", "este", "esto",
  "for", "from", "have", "http", "https", "para", "pero", "que", "sobre", "that", "the", "their",
  "this", "una", "with", "www", "you", "your",
]);

export interface LocalOrganization {
  title: string;
  summary: string;
  category: string;
  tags: string[];
}

function plain(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sentence(value: string, limit = 240): string {
  const clean = plain(value);
  if (!clean) return "Saved material";
  const end = clean.search(/[.!?](?:\s|$)/);
  return clean.slice(0, Math.min(end >= 40 ? end + 1 : clean.length, limit));
}

function inferredTitle(input: string, content: string): string {
  try { return new URL(input).hostname.replace(/^www\./, ""); } catch { /* It is a note or file name. */ }
  const firstLine = (content || input).split(/\r?\n/).map(plain).find(Boolean) ?? "Saved material";
  return firstLine.split(" ").slice(0, 12).join(" ").slice(0, 120);
}

export function organizeLocally(input: string, content = input, supplied: { title?: string; description?: string } = {}): LocalOrganization {
  const source = plain([supplied.title, supplied.description, content, input].filter(Boolean).join(" "));
  const lower = source.toLocaleLowerCase();
  const category = /health|fitness|nutrition|medical|salud|bienestar/.test(lower) ? "Health"
    : /money|finance|invest|budget|tax|dinero|finanzas|impuesto/.test(lower) ? "Finance"
    : /idea|concept|maybe|build|crear|proyecto/.test(lower) ? "Ideas"
    : /course|learn|tutorial|guide|research|curso|aprender|estudio/.test(lower) ? "Learning"
    : /work|business|career|client|meeting|trabajo|negocio|reuni.n/.test(lower) ? "Work"
    : "Reference";
  const counts = new Map<string, number>();
  for (const word of lower.match(/[\p{L}\p{N}]{4,}/gu) ?? []) {
    if (!STOP_WORDS.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([word]) => word);
  return {
    title: plain(supplied.title ?? "").slice(0, 120) || inferredTitle(input, content),
    summary: sentence(supplied.description || content || input),
    category,
    tags,
  };
}
