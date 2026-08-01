import { chunkText } from "./chunks";
import { MAX_LOCAL_FILE_BYTES, MAX_EXTRACTED_TEXT_CHARS } from "./local-file-extract";
import { createLocalEmbedding } from "./local-rag";
import type { Memory, MemoryType, ProcessingStatus } from "./types";

const DATABASE_NAME = "memoria-local";
const DATABASE_VERSION = 2;
const OUTBOX_STORE = "outbox";
const MEMORIES_STORE = "memories";
const CHUNKS_STORE = "chunks";
const SETTINGS_STORE = "settings";
const BACKUP_SCHEMA = "sockdrawer-phone-local";
const BACKUP_VERSION = 1;
const MAX_INPUT_CHARS = 100_000;
const MAX_BACKUP_BYTES = 512_000_000;
const TRACKING_KEYS = new Set(["fbclid", "gclid", "igshid", "mc_cid", "mc_eid", "ref", "ref_src", "si"]);

export interface LocalMemory extends Memory {
  content: string;
  archivePath: string;
  originalFilePath: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  size: number;
  dedupeKey: string;
}

export interface LocalChunk {
  id: string;
  memoryId: string;
  index: number;
  text: string;
  vector: number[];
}

interface SettingRecord {
  key: string;
  value: unknown;
}

interface LegacyOutboxItem {
  clientRequestId: string;
  input: string;
  createdAt: string;
  file?: File;
}

interface BackupFile {
  path: string;
  mimeType: string;
  size: number;
  base64: string;
}

export interface LocalBackup {
  schema: typeof BACKUP_SCHEMA;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  memories: LocalMemory[];
  chunks: LocalChunk[];
  settings: SettingRecord[];
  files: BackupFile[];
}

export interface LocalMemoryFilters {
  query?: string;
  category?: string;
  type?: MemoryType;
  status?: ProcessingStatus;
  limit?: number;
}

export interface LocalMemoryUpdate {
  title?: string | null;
  description?: string | null;
  category?: string;
  tags?: string[];
  sourceDomain?: string | null;
  originalUrl?: string | null;
  normalizedUrl?: string | null;
  processingStatus?: ProcessingStatus;
  processingError?: string | null;
  content?: string;
  chunks?: Array<{ text: string; vector?: number[] }>;
}

export interface LocalStorageStatus {
  persisted: boolean;
  usage: number;
  quota: number;
  percentUsed: number;
  lastBackupAt: string | null;
}

export interface LocalCaptureResult {
  memory: LocalMemory;
  duplicate: boolean;
}

let databasePromise: Promise<IDBDatabase> | null = null;
let initializationPromise: Promise<void> | null = null;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    const fail = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onerror = fail;
    transaction.onabort = fail;
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw new Error("This browser does not support phone-local storage.");
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
        database.createObjectStore(OUTBOX_STORE, { keyPath: "clientRequestId" });
      }
      if (!database.objectStoreNames.contains(MEMORIES_STORE)) {
        const memories = database.createObjectStore(MEMORIES_STORE, { keyPath: "id" });
        memories.createIndex("by-client-request-id", "clientRequestId", { unique: true });
        memories.createIndex("by-dedupe-key", "dedupeKey", { unique: true });
        memories.createIndex("by-created-at", "createdAt");
      }
      if (!database.objectStoreNames.contains(CHUNKS_STORE)) {
        const chunks = database.createObjectStore(CHUNKS_STORE, { keyPath: "id" });
        chunks.createIndex("by-memory-id", "memoryId");
      }
      if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
        database.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error("Could not open phone-local storage."));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("Close other SockDrawer tabs and try again."));
    };
  });
  return databasePromise;
}

async function withTransaction<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const database = await openDatabase();
  const transaction = database.transaction(stores, mode);
  const done = transactionDone(transaction);
  try {
    const result = await operation(transaction);
    await done;
    return result;
  } catch (error) {
    try { transaction.abort(); } catch { /* already closed */ }
    await done.catch(() => undefined);
    throw error;
  }
}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${name}.`);
  return value;
}

function optionalString(value: unknown, name: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > max) throw new Error(`Invalid ${name}.`);
  return value;
}

function nullableString(value: unknown, name: string, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > max) throw new Error(`Invalid ${name}.`);
  return value;
}

function validMimeType(value: unknown): string {
  if (value === "") return "application/octet-stream";
  if (typeof value !== "string" || value.length > 127 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value)) {
    throw new Error("Invalid file MIME type.");
  }
  return value.toLowerCase();
}

function safeFilename(value: string): string {
  const safe = value.normalize("NFKC").replace(/[^a-z0-9._-]+/gi, "_").replace(/^\.+/, "").slice(-90);
  return safe && safe !== "." && safe !== ".." ? safe : "file.bin";
}

export function assertSafeLocalPath(value: unknown): string {
  if (typeof value !== "string" || value.includes("\\") || value.includes("\0") || value.length > 300) {
    throw new Error("Invalid backup file path.");
  }
  const parts = value.split("/");
  const month = Number(parts[2]);
  if (parts.length !== 4 || parts[0] !== "sockdrawer" || !/^\d{4}$/.test(parts[1])
    || !/^\d{2}$/.test(parts[2]) || month < 1 || month > 12
    || !/^[a-z0-9][a-z0-9._-]*$/i.test(parts[3]) || parts.some((part) => part === "." || part === "..")) {
    throw new Error("Invalid backup file path.");
  }
  return value;
}

export function normalizeLocalUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP and HTTPS links are supported.");
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

function looksLikeUrl(input: string): boolean {
  try { normalizeLocalUrl(input); return true; } catch { return false; }
}

async function digest(value: string | ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Secure browser storage hashing is unavailable.");
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...result].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newId(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("Secure ID generation is unavailable in this browser.");
  return crypto.randomUUID();
}

function datedPath(createdAt: string, filename: string): string {
  const date = new Date(createdAt);
  return assertSafeLocalPath(`sockdrawer/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${filename}`);
}

function oneLine(value: string | null | undefined, fallback = ""): string {
  return (value ?? fallback).replace(/\s*[\r\n]+\s*/g, " ").trim();
}

export function formatLocalArchive(memory: LocalMemory): string {
  const source = memory.originalUrl ?? (memory.type === "note" ? "note" : `file: ${memory.rawInput}`);
  return [
    `Title: ${oneLine(memory.title, memory.rawInput)}`,
    `Source: ${oneLine(source)}`,
    `Date: ${new Date(memory.createdAt).toISOString()}`,
    `Tags: ${memory.tags.map((tag) => oneLine(tag)).filter(Boolean).join(", ")}`,
    `Category: ${oneLine(memory.category, "Inbox")}`,
    "",
    "Summary:",
    oneLine(memory.description),
    "",
    "Content:",
    memory.content.trim(),
    "",
  ].join("\n");
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    throw new Error("Origin Private File System is unavailable. Use current Android Chrome.");
  }
  return navigator.storage.getDirectory();
}

async function fileHandle(path: string, create: boolean): Promise<FileSystemFileHandle> {
  const parts = assertSafeLocalPath(path).split("/");
  let directory = await opfsRoot();
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create });
  return directory.getFileHandle(parts.at(-1)!, { create });
}

async function writeFile(path: string, value: Blob | string | ArrayBuffer | Uint8Array): Promise<void> {
  const handle = await fileHandle(path, true);
  const writable = await handle.createWritable();
  try {
    if (value instanceof Uint8Array) {
      const buffer = new ArrayBuffer(value.byteLength);
      new Uint8Array(buffer).set(value);
      await writable.write(buffer);
    } else {
      await writable.write(value);
    }
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

async function readFile(path: string): Promise<File> {
  return (await fileHandle(path, false)).getFile();
}

async function fileExists(path: string): Promise<boolean> {
  try { await fileHandle(path, false); return true; } catch (error) {
    if ((error as DOMException).name === "NotFoundError") return false;
    throw error;
  }
}

async function removeFile(path: string): Promise<void> {
  const parts = assertSafeLocalPath(path).split("/");
  let directory = await opfsRoot();
  try {
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    await directory.removeEntry(parts.at(-1)!);
  } catch (error) {
    if ((error as DOMException).name !== "NotFoundError") throw error;
  }
}

function chunksFor(memoryId: string, content: string, supplied?: LocalMemoryUpdate["chunks"]): LocalChunk[] {
  const chunks: Array<{ text: string; vector?: number[] }> = supplied ?? chunkText(content).map((text) => ({ text }));
  return chunks.map((chunk, index) => {
    const text = requiredString(chunk.text, "chunk text", MAX_EXTRACTED_TEXT_CHARS);
    const vector = chunk.vector?.length ? chunk.vector : createLocalEmbedding(text);
    if ((vector.length !== 0 && vector.length !== 512) || vector.some((value) => !Number.isFinite(value))) {
      throw new Error("Invalid chunk vector.");
    }
    return { id: `${memoryId}:${index}`, memoryId, index, text, vector: [...vector] };
  });
}

async function storedMemoryByIndex(indexName: string, value: IDBValidKey): Promise<LocalMemory | null> {
  return withTransaction(MEMORIES_STORE, "readonly", async (transaction) => {
    const result = await requestResult(transaction.objectStore(MEMORIES_STORE).index(indexName).get(value));
    return (result as LocalMemory | undefined) ?? null;
  });
}

async function captureDirect(
  rawInput: string,
  file?: File,
  options: { clientRequestId?: string; type?: MemoryType; title?: string } = {},
): Promise<LocalCaptureResult> {
  const displayFilename = file?.name.trim().slice(0, 255) || null;
  const input = (file ? displayFilename : rawInput)?.trim() ?? "";
  requiredString(input, "capture input", MAX_INPUT_CHARS);
  if (file && (!file.size || file.size > MAX_LOCAL_FILE_BYTES)) {
    throw new Error(file.size ? "The selected file is larger than the 25 MB limit." : "The selected file is empty.");
  }
  const clientRequestId = options.clientRequestId ?? newId();
  requiredString(clientRequestId, "capture request ID", 128);
  const type: MemoryType = options.type ?? (file
    ? (file.type.startsWith("image/") ? "image" : "document")
    : (looksLikeUrl(input) ? "url" : "note"));
  const originalUrl = type === "url" ? input : null;
  const normalizedUrl = originalUrl ? normalizeLocalUrl(originalUrl) : null;
  const fileBytes = file ? await file.arrayBuffer() : null;
  const dedupeKey = await digest(fileBytes ?? normalizedUrl ?? input);

  const idempotent = await storedMemoryByIndex("by-client-request-id", clientRequestId);
  if (idempotent) return { memory: idempotent, duplicate: false };
  const duplicate = await storedMemoryByIndex("by-dedupe-key", dedupeKey);
  if (duplicate) return { memory: duplicate, duplicate: true };

  const id = newId();
  const createdAt = new Date().toISOString();
  const storedFilename = displayFilename ? safeFilename(displayFilename) : null;
  const title = options.title?.trim() || displayFilename?.slice(0, 120) || null;
  optionalString(title, "capture label", 120);
  const archivePath = datedPath(createdAt, `${id}.txt`);
  const originalFilePath = storedFilename ? datedPath(createdAt, `${id}--${storedFilename}`) : null;
  const memory: LocalMemory = {
    id,
    clientRequestId,
    type,
    rawInput: input,
    originalUrl,
    normalizedUrl,
    title,
    description: null,
    category: "Inbox",
    tags: [],
    sourceDomain: normalizedUrl ? new URL(normalizedUrl).hostname : null,
    processingStatus: type === "note" ? "ready" : "pending",
    processingError: null,
    createdAt,
    updatedAt: createdAt,
    content: type === "note" ? input : input,
    archivePath,
    originalFilePath,
    originalFilename: displayFilename,
    mimeType: file ? validMimeType(file.type) : null,
    size: file?.size ?? new TextEncoder().encode(input).byteLength,
    dedupeKey,
  };
  const written: string[] = [];
  try {
    if (originalFilePath && fileBytes) {
      await writeFile(originalFilePath, fileBytes);
      written.push(originalFilePath);
    }
    await writeFile(archivePath, formatLocalArchive(memory));
    written.push(archivePath);

    const transactionResult = await withTransaction([MEMORIES_STORE, CHUNKS_STORE], "readwrite", async (transaction) => {
      const store = transaction.objectStore(MEMORIES_STORE);
      const sameRequest = await requestResult(store.index("by-client-request-id").get(clientRequestId)) as LocalMemory | undefined;
      if (sameRequest) return { memory: sameRequest, duplicate: false, inserted: false };
      const sameContent = await requestResult(store.index("by-dedupe-key").get(dedupeKey)) as LocalMemory | undefined;
      if (sameContent) return { memory: sameContent, duplicate: true, inserted: false };
      await requestResult(store.add(memory));
      const chunks = transaction.objectStore(CHUNKS_STORE);
      for (const chunk of chunksFor(id, memory.content)) await requestResult(chunks.add(chunk));
      return { memory, duplicate: false, inserted: true };
    });
    if (!transactionResult.inserted) await Promise.all(written.map(removeFile));
    return { memory: transactionResult.memory, duplicate: transactionResult.duplicate };
  } catch (error) {
    await Promise.allSettled(written.map(removeFile));
    const raced = await storedMemoryByIndex("by-client-request-id", clientRequestId).catch(() => null)
      ?? await storedMemoryByIndex("by-dedupe-key", dedupeKey).catch(() => null);
    if (raced) return { memory: raced, duplicate: raced.clientRequestId !== clientRequestId };
    throw error;
  }
}

async function allFromStore<T>(storeName: string): Promise<T[]> {
  return withTransaction(storeName, "readonly", async (transaction) => (
    requestResult(transaction.objectStore(storeName).getAll()) as Promise<T[]>
  ));
}

async function initialize(): Promise<void> {
  initializationPromise ??= (async () => {
    await openDatabase();
    await migrateOutboxDirect();
  })();
  return initializationPromise;
}

async function migrateOutboxDirect(): Promise<{ migrated: number; failed: number }> {
  const items = await allFromStore<LegacyOutboxItem>(OUTBOX_STORE);
  let migrated = 0;
  let failed = 0;
  for (const item of items) {
    try {
      const file = item.file instanceof File ? item.file : undefined;
      await captureDirect(item.input, file, { clientRequestId: item.clientRequestId });
      await withTransaction(OUTBOX_STORE, "readwrite", async (transaction) => {
        await requestResult(transaction.objectStore(OUTBOX_STORE).delete(item.clientRequestId));
      });
      migrated += 1;
    } catch {
      failed += 1;
    }
  }
  return { migrated, failed };
}

function validateMemory(value: unknown): LocalMemory {
  if (!value || typeof value !== "object") throw new Error("Invalid backup memory.");
  const memory = value as Partial<LocalMemory>;
  requiredString(memory.id, "memory ID", 128);
  requiredString(memory.clientRequestId, "client request ID", 128);
  if (!(["url", "note", "image", "document"] as unknown[]).includes(memory.type)) throw new Error("Invalid memory type.");
  requiredString(memory.rawInput, "memory input", MAX_INPUT_CHARS);
  nullableString(memory.originalUrl, "source URL", 10_000);
  nullableString(memory.normalizedUrl, "normalized URL", 10_000);
  nullableString(memory.title, "title", 120);
  nullableString(memory.description, "description", 280);
  requiredString(memory.category, "category", 40);
  if (!Array.isArray(memory.tags) || memory.tags.length > 12 || memory.tags.some((tag) => typeof tag !== "string" || !tag || tag.length > 40)) throw new Error("Invalid memory tags.");
  if (!(["pending", "processing", "ready", "needs_review", "failed"] as unknown[]).includes(memory.processingStatus)) throw new Error("Invalid memory status.");
  nullableString(memory.sourceDomain, "source domain", 255);
  nullableString(memory.processingError, "processing error", 1_000);
  requiredString(memory.createdAt, "created date", 64);
  requiredString(memory.updatedAt, "updated date", 64);
  if (!Number.isFinite(Date.parse(memory.createdAt!)) || !Number.isFinite(Date.parse(memory.updatedAt!))) throw new Error("Invalid memory date.");
  requiredString(memory.content, "memory content", MAX_EXTRACTED_TEXT_CHARS);
  assertSafeLocalPath(memory.archivePath);
  if (memory.archivePath !== datedPath(memory.createdAt!, `${memory.id}.txt`)) throw new Error("Invalid memory archive path.");
  if (memory.originalFilePath !== null) assertSafeLocalPath(memory.originalFilePath);
  if (memory.originalFilename !== null) requiredString(memory.originalFilename, "original filename", 255);
  if (memory.mimeType !== null) validMimeType(memory.mimeType);
  if (!Number.isInteger(memory.size) || memory.size! < 0 || memory.size! > MAX_LOCAL_FILE_BYTES) throw new Error("Invalid memory file size.");
  if (memory.originalFilePath && !memory.originalFilePath.startsWith(memory.archivePath.slice(0, -4) + "--")) throw new Error("Invalid original file path.");
  if (Boolean(memory.originalFilePath) !== Boolean(memory.originalFilename) || Boolean(memory.originalFilePath) !== Boolean(memory.mimeType)) {
    throw new Error("Incomplete original file metadata.");
  }
  if (typeof memory.dedupeKey !== "string" || !/^[a-f0-9]{64}$/.test(memory.dedupeKey)) throw new Error("Invalid memory checksum.");
  return memory as LocalMemory;
}

function validateChunk(value: unknown, memoryIds: Set<string>): LocalChunk {
  if (!value || typeof value !== "object") throw new Error("Invalid backup chunk.");
  const chunk = value as Partial<LocalChunk>;
  requiredString(chunk.id, "chunk ID", 180);
  requiredString(chunk.memoryId, "chunk memory ID", 128);
  if (!memoryIds.has(chunk.memoryId!)) throw new Error("Backup chunk refers to a missing memory.");
  if (!Number.isInteger(chunk.index) || chunk.index! < 0 || chunk.index! > 100_000) throw new Error("Invalid chunk index.");
  requiredString(chunk.text, "chunk text", MAX_EXTRACTED_TEXT_CHARS);
  if (!Array.isArray(chunk.vector) || chunk.vector.length !== 0 && chunk.vector.length !== 512
    || chunk.vector.some((number) => !Number.isFinite(number))) throw new Error("Invalid chunk vector.");
  return chunk as LocalChunk;
}

function base64ToBytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid backup file encoding.");
  }
  let binary: string;
  try { binary = atob(value); } catch { throw new Error("Invalid backup file encoding."); }
  if (binary.length > MAX_LOCAL_FILE_BYTES) throw new Error("A backup file exceeds the 25 MB limit.");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 32_768));
  }
  return btoa(binary);
}

export function parseLocalBackup(input: string): LocalBackup {
  let raw: unknown;
  try { raw = JSON.parse(input); } catch { throw new Error("The backup is not valid JSON."); }
  if (!raw || typeof raw !== "object") throw new Error("Invalid SockDrawer backup.");
  const backup = raw as Partial<LocalBackup>;
  if (backup.schema !== BACKUP_SCHEMA || backup.version !== BACKUP_VERSION) throw new Error("Unsupported SockDrawer backup version.");
  if (!Array.isArray(backup.memories) || !Array.isArray(backup.chunks) || !Array.isArray(backup.settings) || !Array.isArray(backup.files)) {
    throw new Error("Incomplete SockDrawer backup.");
  }
  if (backup.memories.length > 100_000 || backup.chunks.length > 3_200_000 || backup.files.length > 200_000) {
    throw new Error("The backup contains too many records.");
  }
  const memories = backup.memories.map(validateMemory);
  const memoryIds = new Set(memories.map((memory) => memory.id));
  if (memoryIds.size !== memories.length || new Set(memories.map((memory) => memory.clientRequestId)).size !== memories.length
    || new Set(memories.map((memory) => memory.dedupeKey)).size !== memories.length) throw new Error("The backup contains duplicate memories.");
  const chunks = backup.chunks.map((chunk) => validateChunk(chunk, memoryIds));
  if (new Set(chunks.map((chunk) => chunk.id)).size !== chunks.length) throw new Error("The backup contains duplicate chunks.");
  const settings = backup.settings.map((setting) => {
    if (!setting || typeof setting !== "object") throw new Error("Invalid backup setting.");
    const record = setting as SettingRecord;
    requiredString(record.key, "setting key", 128);
    if (record.value === undefined || JSON.stringify(record.value) === undefined) throw new Error("Invalid setting value.");
    return record;
  });
  if (new Set(settings.map((setting) => setting.key)).size !== settings.length) throw new Error("The backup contains duplicate settings.");

  const expectedMimeTypes = new Map(memories.flatMap((memory) => [
    [memory.archivePath, "text/plain"] as const,
    ...(memory.originalFilePath ? [[memory.originalFilePath, memory.mimeType ?? "application/octet-stream"] as const] : []),
  ]));
  const expectedFiles = new Set(expectedMimeTypes.keys());
  const paths = new Set<string>();
  const files = backup.files.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid backup file.");
    const file = entry as BackupFile;
    const path = assertSafeLocalPath(file.path);
    if (!expectedFiles.has(path) || paths.has(path)) throw new Error("Backup contains an unexpected or duplicate file.");
    paths.add(path);
    const mimeType = validMimeType(file.mimeType);
    if (mimeType !== expectedMimeTypes.get(path)) throw new Error("Backup file MIME type does not match its memory.");
    const bytes = base64ToBytes(file.base64);
    if (!Number.isInteger(file.size) || file.size !== bytes.byteLength) throw new Error("Backup file size does not match its content.");
    return { path, mimeType, size: file.size, base64: file.base64 };
  });
  if (paths.size !== expectedFiles.size || [...expectedFiles].some((path) => !paths.has(path))) throw new Error("Backup is missing a stored file.");
  const exportedAt = requiredString(backup.exportedAt, "export date", 64);
  if (!Number.isFinite(Date.parse(exportedAt))) throw new Error("Invalid backup export date.");
  return { schema: BACKUP_SCHEMA, version: BACKUP_VERSION, exportedAt, memories, chunks, settings, files };
}

export class LocalMemoryStore {
  async initialize(): Promise<void> {
    await initialize();
  }

  async migrateOutbox(): Promise<{ migrated: number; failed: number }> {
    await openDatabase();
    return migrateOutboxDirect();
  }

  async captureText(input: string, options: { clientRequestId?: string; type?: "url" | "note"; title?: string } = {}): Promise<LocalCaptureResult> {
    await initialize();
    return captureDirect(input, undefined, options);
  }

  async captureFile(file: File, options: { clientRequestId?: string; title?: string } = {}): Promise<LocalCaptureResult> {
    await initialize();
    return captureDirect(file.name, file, options);
  }

  async get(id: string): Promise<LocalMemory | null> {
    await initialize();
    requiredString(id, "memory ID", 128);
    return withTransaction(MEMORIES_STORE, "readonly", async (transaction) => (
      (await requestResult(transaction.objectStore(MEMORIES_STORE).get(id)) as LocalMemory | undefined) ?? null
    ));
  }

  async list(filters: LocalMemoryFilters = {}): Promise<LocalMemory[]> {
    await initialize();
    const query = filters.query?.trim().toLocaleLowerCase() ?? "";
    // ponytail: a phone-local scan is simplest up to 10k items; add cursor paging only if a real library exceeds it.
    const limit = Number.isInteger(filters.limit) ? Math.min(Math.max(filters.limit!, 1), 10_000) : 10_000;
    const memories = await allFromStore<LocalMemory>(MEMORIES_STORE);
    return memories
      .filter((memory) => !filters.category || memory.category === filters.category)
      .filter((memory) => !filters.type || memory.type === filters.type)
      .filter((memory) => !filters.status || memory.processingStatus === filters.status)
      .filter((memory) => !query || [memory.title, memory.description, memory.rawInput, memory.content, memory.tags.join(" ")]
        .some((value) => value?.toLocaleLowerCase().includes(query)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async search(query: string, limit = 100): Promise<LocalMemory[]> {
    requiredString(query, "search query", 500);
    return this.list({ query, limit });
  }

  async getChunks(memoryIds?: string[]): Promise<LocalChunk[]> {
    await initialize();
    const wanted = memoryIds ? new Set(memoryIds) : null;
    return (await allFromStore<LocalChunk>(CHUNKS_STORE))
      .filter((chunk) => !wanted || wanted.has(chunk.memoryId))
      .sort((left, right) => left.memoryId.localeCompare(right.memoryId) || left.index - right.index);
  }

  async update(id: string, changes: LocalMemoryUpdate): Promise<LocalMemory | null> {
    await initialize();
    const current = await this.get(id);
    if (!current) return null;
    const updated: LocalMemory = {
      ...current,
      ...(changes.title !== undefined ? { title: changes.title === null ? null : optionalString(changes.title, "title", 120) } : {}),
      ...(changes.description !== undefined ? { description: changes.description === null ? null : optionalString(changes.description, "description", 280) } : {}),
      ...(changes.category !== undefined ? { category: requiredString(changes.category, "category", 40) } : {}),
      ...(changes.sourceDomain !== undefined ? { sourceDomain: changes.sourceDomain } : {}),
      ...(changes.originalUrl !== undefined ? { originalUrl: changes.originalUrl } : {}),
      ...(changes.normalizedUrl !== undefined ? { normalizedUrl: changes.normalizedUrl } : {}),
      ...(changes.processingStatus !== undefined ? { processingStatus: changes.processingStatus } : {}),
      ...(changes.processingError !== undefined ? { processingError: changes.processingError } : {}),
      ...(changes.content !== undefined ? { content: requiredString(changes.content, "memory content", MAX_EXTRACTED_TEXT_CHARS) } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (changes.tags !== undefined) {
      if (!Array.isArray(changes.tags) || changes.tags.length > 12) throw new Error("Invalid memory tags.");
      updated.tags = [...new Set(changes.tags.map((tag) => requiredString(tag.trim().toLowerCase(), "tag", 40)))];
    }
    optionalString(updated.sourceDomain, "source domain", 255);
    optionalString(updated.originalUrl, "source URL", 10_000);
    optionalString(updated.normalizedUrl, "normalized URL", 10_000);
    optionalString(updated.processingError, "processing error", 1_000);
    const replacementChunks = changes.content !== undefined || changes.chunks !== undefined
      ? chunksFor(id, updated.content, changes.chunks)
      : null;

    await writeFile(updated.archivePath, formatLocalArchive(updated));
    try {
      await withTransaction([MEMORIES_STORE, CHUNKS_STORE], "readwrite", async (transaction) => {
        await requestResult(transaction.objectStore(MEMORIES_STORE).put(updated));
        if (replacementChunks) {
          const chunks = transaction.objectStore(CHUNKS_STORE);
          const index = chunks.index("by-memory-id");
          for (const key of await requestResult(index.getAllKeys(id))) await requestResult(chunks.delete(key));
          for (const chunk of replacementChunks) await requestResult(chunks.put(chunk));
        }
      });
    } catch (error) {
      await writeFile(current.archivePath, formatLocalArchive(current)).catch(() => undefined);
      throw error;
    }
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    await initialize();
    const memory = await this.get(id);
    if (!memory) return false;
    await withTransaction([MEMORIES_STORE, CHUNKS_STORE], "readwrite", async (transaction) => {
      const chunks = transaction.objectStore(CHUNKS_STORE);
      for (const key of await requestResult(chunks.index("by-memory-id").getAllKeys(id))) await requestResult(chunks.delete(key));
      await requestResult(transaction.objectStore(MEMORIES_STORE).delete(id));
    });
    await Promise.allSettled([memory.archivePath, memory.originalFilePath].filter(Boolean).map((path) => removeFile(path!)));
    return true;
  }

  async readOriginal(id: string): Promise<File | null> {
    const memory = await this.get(id);
    if (!memory?.originalFilePath) return null;
    const file = await readFile(memory.originalFilePath);
    return new File([file], memory.originalFilename ?? file.name, { type: memory.mimeType ?? file.type });
  }

  async openFile(id: string): Promise<File | null> {
    const memory = await this.get(id);
    if (!memory) return null;
    if (memory.originalFilePath) return this.readOriginal(id);
    const file = await readFile(memory.archivePath);
    return new File([file], `${safeFilename(memory.title ?? memory.id)}.txt`, { type: "text/plain" });
  }

  async openOriginal(id: string): Promise<boolean> {
    const file = await this.readOriginal(id);
    if (!file || typeof document === "undefined") return false;
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  }

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    await initialize();
    requiredString(key, "setting key", 128);
    const record = await withTransaction(SETTINGS_STORE, "readonly", async (transaction) => (
      requestResult(transaction.objectStore(SETTINGS_STORE).get(key)) as Promise<SettingRecord | undefined>
    ));
    return record ? record.value as T : fallback;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await initialize();
    requiredString(key, "setting key", 128);
    if (value === undefined || JSON.stringify(value) === undefined) throw new Error("Invalid setting value.");
    await withTransaction(SETTINGS_STORE, "readwrite", async (transaction) => {
      await requestResult(transaction.objectStore(SETTINGS_STORE).put({ key, value } satisfies SettingRecord));
    });
  }

  async requestPersistence(): Promise<boolean> {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
    return navigator.storage.persist();
  }

  async storageStatus(): Promise<LocalStorageStatus> {
    await initialize();
    const estimate = typeof navigator !== "undefined" && navigator.storage?.estimate
      ? await navigator.storage.estimate()
      : {};
    const persisted = typeof navigator !== "undefined" && navigator.storage?.persisted
      ? await navigator.storage.persisted()
      : false;
    const usage = estimate.usage ?? 0;
    const quota = estimate.quota ?? 0;
    return {
      persisted,
      usage,
      quota,
      percentUsed: quota ? usage / quota * 100 : 0,
      lastBackupAt: await this.getSetting<string | null>("lastBackupAt", null),
    };
  }

  async exportBackup(): Promise<Blob> {
    await initialize();
    const [memories, chunks, settings] = await Promise.all([
      allFromStore<LocalMemory>(MEMORIES_STORE),
      allFromStore<LocalChunk>(CHUNKS_STORE),
      allFromStore<SettingRecord>(SETTINGS_STORE),
    ]);
    const files: BackupFile[] = [];
    for (const memory of memories) {
      for (const [path, mimeType] of [[memory.archivePath, "text/plain"], [memory.originalFilePath, memory.mimeType]] as const) {
        if (!path) continue;
        const file = await readFile(path);
        if (file.size > MAX_LOCAL_FILE_BYTES) throw new Error("A stored file exceeds the 25 MB backup limit.");
        files.push({ path, mimeType: validMimeType(mimeType ?? "application/octet-stream"), size: file.size, base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())) });
      }
    }
    const exportedAt = new Date().toISOString();
    const backupSettings = [...settings.filter((setting) => setting.key !== "lastBackupAt"), { key: "lastBackupAt", value: exportedAt }];
    const backup: LocalBackup = { schema: BACKUP_SCHEMA, version: BACKUP_VERSION, exportedAt, memories, chunks, settings: backupSettings, files };
    const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
    await this.setSetting("lastBackupAt", backup.exportedAt);
    return blob;
  }

  async importBackup(source: Blob | string): Promise<{ imported: number }> {
    await initialize();
    if (source instanceof Blob && source.size > MAX_BACKUP_BYTES) throw new Error("The backup is too large to import safely.");
    const backup = parseLocalBackup(typeof source === "string" ? source : await source.text());
    const existingIds = new Set((await allFromStore<LocalMemory>(MEMORIES_STORE)).flatMap((memory) => [memory.id, memory.clientRequestId, memory.dedupeKey]));
    if (backup.memories.some((memory) => existingIds.has(memory.id) || existingIds.has(memory.clientRequestId) || existingIds.has(memory.dedupeKey))) {
      throw new Error("This backup overlaps memories already on this phone. Clear them first or import a different backup.");
    }
    for (const file of backup.files) {
      if (await fileExists(file.path)) throw new Error("A backup file path is already in use on this phone.");
    }

    const written: string[] = [];
    try {
      for (const file of backup.files) {
        await writeFile(file.path, base64ToBytes(file.base64));
        written.push(file.path);
      }
      await withTransaction([MEMORIES_STORE, CHUNKS_STORE, SETTINGS_STORE], "readwrite", async (transaction) => {
        const memories = transaction.objectStore(MEMORIES_STORE);
        for (const memory of backup.memories) await requestResult(memories.add(memory));
        const chunks = transaction.objectStore(CHUNKS_STORE);
        for (const chunk of backup.chunks) await requestResult(chunks.add(chunk));
        const settings = transaction.objectStore(SETTINGS_STORE);
        for (const setting of backup.settings) await requestResult(settings.put(setting));
      });
      return { imported: backup.memories.length };
    } catch (error) {
      await Promise.allSettled(written.map(removeFile));
      throw error;
    }
  }

  async clear(): Promise<void> {
    await initialize();
    await withTransaction([MEMORIES_STORE, CHUNKS_STORE], "readwrite", async (transaction) => {
      await requestResult(transaction.objectStore(MEMORIES_STORE).clear());
      await requestResult(transaction.objectStore(CHUNKS_STORE).clear());
    });
    try { await (await opfsRoot()).removeEntry("sockdrawer", { recursive: true }); } catch (error) {
      if ((error as DOMException).name !== "NotFoundError") throw error;
    }
  }
}

export const localMemory = new LocalMemoryStore();
