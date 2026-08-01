export const MAX_LOCAL_FILE_BYTES = 25_000_000;
export const MAX_EXTRACTED_TEXT_CHARS = 500_000;

export interface LocalFileExtraction {
  title: string;
  description: string;
  text: string;
  mimeType: string;
  supported: boolean;
  lowConfidence: boolean;
}

function filename(file: Blob & { name?: string }): string {
  return file.name?.trim() || "Saved file";
}

function cleanText(value: string): string {
  return value
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .trim()
    .slice(0, MAX_EXTRACTED_TEXT_CHARS);
}

function isPlainText(name: string, mimeType: string): boolean {
  return /^text\//i.test(mimeType)
    || /(?:json|xml|markdown|csv|javascript|typescript)/i.test(mimeType)
    || /\.(?:txt|md|markdown|csv|json|html?|xml|js|ts)$/i.test(name);
}

async function extractPdf(file: Blob): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Loading the packaged worker module keeps PDF extraction available offline.
  const scope = globalThis as typeof globalThis & { pdfjsWorker?: unknown };
  // @ts-expect-error pdfjs-dist ships the worker module without a declaration file.
  scope.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useSystemFonts: true,
    useWorkerFetch: false,
  });
  const document = await task.promise;
  const pages: string[] = [];
  let length = 0;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages && length < MAX_EXTRACTED_TEXT_CHARS; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) {
        pages.push(text);
        length += text.length + 2;
      }
    }
  } finally {
    await task.destroy();
  }
  return cleanText(pages.join("\n\n"));
}

export async function extractLocalFile(file: Blob & { name?: string }): Promise<LocalFileExtraction> {
  if (!file.size) throw new Error("The selected file is empty.");
  if (file.size > MAX_LOCAL_FILE_BYTES) throw new Error("The selected file is larger than the 25 MB limit.");

  const title = filename(file);
  const mimeType = file.type || "application/octet-stream";
  const isPdf = mimeType === "application/pdf" || /\.pdf$/i.test(title);
  if (isPdf) {
    const text = await extractPdf(file);
    return {
      title,
      description: text ? "PDF text extracted locally." : "PDF saved, but it contains no selectable text.",
      text,
      mimeType,
      supported: true,
      lowConfidence: text.length < 20,
    };
  }

  if (isPlainText(title, mimeType)) {
    const text = cleanText(await file.text());
    return {
      title,
      description: text ? "Document text extracted locally." : "Document saved, but it contains no text.",
      text,
      mimeType,
      supported: true,
      lowConfidence: text.length < 20,
    };
  }

  return {
    title,
    description: "File saved locally. Text extraction is not available for this format.",
    text: "",
    mimeType,
    supported: false,
    lowConfidence: true,
  };
}
