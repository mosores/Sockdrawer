export type MemoryType = "url" | "note" | "image" | "document";
export type ProcessingStatus = "pending" | "processing" | "ready" | "needs_review" | "failed";

export interface Memory {
  id: string;
  clientRequestId: string;
  type: MemoryType;
  rawInput: string;
  originalUrl: string | null;
  normalizedUrl: string | null;
  title: string | null;
  description: string | null;
  category: string;
  tags: string[];
  sourceDomain: string | null;
  processingStatus: ProcessingStatus;
  processingError: string | null;
  createdAt: string;
  updatedAt: string;
}
