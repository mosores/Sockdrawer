"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { extractLocalFile } from "@/lib/local-file-extract";
import { localMemory, type LocalMemory, type LocalStorageStatus } from "@/lib/local-memory";
import { organizeLocally } from "@/lib/local-processing";
import { LocalRag, buildChatGptPacket, chunkText, createLocalEmbedding, type RagResult } from "@/lib/local-rag";

type Tab = "capture" | "inbox" | "library" | "ask";
type Notice = { kind: "success" | "warning" | "error"; text: string; saved?: boolean } | null;
type ShareOutcome = "shared" | "copied" | "cancelled";
type ExtractedLink = { title: string; content: string; sourceDomain: string; canonicalUrl: string };

const SHARED_INPUT_KEY = "sockdrawer-shared-input";
const ACCESS_KEY_SETTING = "extractorAccessKey";
const TAB_STORAGE = "sockdrawer-tab";
const OFFLINE_CACHE = "sockdrawer-shell-v4";
const MAX_CAPTURE_CHARS = 100_000;
const processing = new Set<string>();
const rag = new LocalRag(localMemory);
const STUDY_PROMPTS = [
  "What are the key ideas I should remember?",
  "Turn my saved materials into a quick study guide.",
  "What sources do I have on this topic?",
];

function Icon({ name, size = 20 }: { name: "spark" | "sock" | "inbox" | "library" | "ask" | "send" | "search" | "link" | "note" | "refresh" | "lock" | "external" | "check" | "warning" | "error" | "trash" | "spinner" | "share" | "download" | "upload"; size?: number }) {
  const paths: Record<string, ReactNode> = {
    spark: <><path d="M12 3l1.2 4.1L17 9l-3.8 1.9L12 15l-1.2-4.1L7 9l3.8-1.9L12 3Z"/><path d="M5 15l.7 2.3L8 18.5l-2.3 1.2L5 22l-.7-2.3L2 18.5l2.3-1.2L5 15Z"/></>,
    sock: <><path d="M8 3h8v7a5 5 0 0 0 3 4.6l1.2.5a3.8 3.8 0 0 1-2.6 7.1L7.8 19a4.5 4.5 0 0 1-2.1-7.5L8 9.5V3Z"/><circle cx="10.5" cy="7" r="0.75" fill="currentColor" stroke="none"/><circle cx="13.5" cy="7" r="0.75" fill="currentColor" stroke="none"/></>,
    inbox: <><path d="M4 5h16v13H4z"/><path d="M4 14h4l2 2h4l2-2h4"/></>,
    library: <><path d="M5 4h4v16H5zM10 4h4v16h-4z"/><path d="m15 5 3.5-1 3.5 14-3.5 1z"/></>,
    ask: <><path d="M5 5h14v11H9l-4 4V5Z"/><path d="M9 9h6M9 12h4"/></>,
    send: <><path d="m3 11 18-8-8 18-2-8-8-2Z"/><path d="m11 13 10-10"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></>,
    link: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"/></>,
    note: <><path d="M5 3h11l3 3v15H5z"/><path d="M15 3v4h4M8 11h8M8 15h6"/></>,
    refresh: <><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 1-2-6"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v7H4V6h7"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    warning: <><path d="M12 9v4"/><circle cx="12" cy="16" r="0.5" fill="currentColor"/><path d="m10.5 4 -8 14h19l-8-14a1.5 1.5 0 0 0-3 0Z"/></>,
    error: <><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/></>,
    trash: <><path d="M4 7h16M9 7V5h6v2"/><path d="M5 7l1 12h12l1-12"/><path d="M10 11v5M14 11v5"/></>,
    spinner: <><circle cx="12" cy="12" r="9" strokeOpacity="0.25"/><path d="M12 3a9 9 0 0 1 9 9" strokeLinecap="round"/></>,
    share: <><circle cx="18" cy="5" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="19" r="2"/><path d="m8 11 8-5M8 13l8 5"/></>,
    download: <><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></>,
    upload: <><path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 21h14"/></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function SaveDrawerMark() {
  return <span className="save-drawer-mark" aria-hidden="true"><span className="save-drawer-sock"><Icon name="sock" size={20}/></span><span className="save-drawer-slot"/><span className="save-drawer-front"/></span>;
}

async function warmOfflineShell() {
  if (!("caches" in window)) return;
  const paths = new Set<string>(["/"]);
  for (const entry of performance.getEntriesByType("resource")) {
    try {
      const url = new URL(entry.name);
      if (url.origin === window.location.origin && url.pathname.startsWith("/_next/")) paths.add(url.pathname + url.search);
    } catch { /* Ignore malformed performance entries. */ }
  }
  const cache = await caches.open(OFFLINE_CACHE);
  await Promise.all([...paths].map(async (path) => {
    try {
      const response = await fetch(path);
      if (response.ok && response.type === "basic") await cache.put(path, response);
    } catch { /* A cache miss must never interrupt normal use. */ }
  }));
}

async function extractLink(url: string, accessKey: string): Promise<ExtractedLink> {
  const response = await fetch("/api/extract", {
    method: "POST",
    headers: { "content-type": "application/json", "x-memoria-key": accessKey },
    body: JSON.stringify({ url }),
  });
  const payload = await response.json().catch(() => ({})) as Partial<ExtractedLink> & { error?: string };
  if (!response.ok) {
    const error = new Error(payload.error || "The link could not be read.") as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  if (!payload.title || !payload.content || !payload.sourceDomain || !payload.canonicalUrl) throw new Error("The link reader returned incomplete content.");
  return payload as ExtractedLink;
}

async function processMemory(memory: LocalMemory, accessKey: string): Promise<void> {
  if (processing.has(memory.id)) return;
  processing.add(memory.id);
  try {
    await localMemory.update(memory.id, { processingStatus: "processing", processingError: null });
    let content = memory.content;
    let supplied: { title?: string; description?: string } = memory.title ? { title: memory.title } : {};
    let sourceDomain = memory.sourceDomain;
    let status: LocalMemory["processingStatus"] = "ready";
    let processingError: string | null = null;

    if (memory.type === "url") {
      if (!accessKey) {
        await localMemory.update(memory.id, { processingStatus: "pending", processingError: "Add the Vercel link-reader key in Review." });
        return;
      }
      if (!navigator.onLine) {
        await localMemory.update(memory.id, { processingStatus: "pending", processingError: "Waiting for an internet connection to read this link." });
        return;
      }
      const extracted = await extractLink(memory.originalUrl || memory.rawInput, accessKey);
      content = extracted.content;
      supplied = { title: memory.title || extracted.title };
      sourceDomain = extracted.sourceDomain;
      if (content.length < 80) {
        status = "needs_review";
        processingError = "The link was saved, but little searchable text was found.";
      }
    } else if (memory.originalFilePath) {
      const file = await localMemory.readOriginal(memory.id);
      if (!file) throw new Error("The original file is missing from phone storage.");
      const extracted = await extractLocalFile(file);
      content = extracted.text || memory.content;
      supplied = { title: memory.title || extracted.title, description: extracted.description };
      if (!extracted.supported || extracted.lowConfidence) {
        status = "needs_review";
        processingError = extracted.description;
      }
    }

    const organized = organizeLocally(memory.rawInput, content, supplied);
    const chunks = chunkText(content || memory.rawInput).map((text) => ({ text, vector: createLocalEmbedding(text) }));
    await localMemory.update(memory.id, {
      title: organized.title,
      description: organized.summary,
      category: organized.category,
      tags: organized.tags,
      sourceDomain,
      content: content || memory.rawInput,
      chunks,
      processingStatus: status,
      processingError,
    });
  } catch (error) {
    const retryable = memory.type === "url" && (!navigator.onLine || error instanceof TypeError);
    await localMemory.update(memory.id, {
      processingStatus: retryable ? "pending" : "failed",
      processingError: retryable ? "Waiting for an internet connection to read this link." : error instanceof Error ? error.message : "Processing failed.",
    }).catch(() => undefined);
  } finally {
    processing.delete(memory.id);
  }
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Use the DOM fallback below. */ }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.className = "clipboard-fallback";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Could not copy the prompt.");
}

async function shareOrCopy(title: string, text: string): Promise<ShareOutcome> {
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return "shared";
    } catch (error) {
      if ((error as DOMException).name === "AbortError") return "cancelled";
    }
  }
  await copyText(text);
  return "copied";
}

function shareNotice(outcome: ShareOutcome): Notice {
  if (outcome === "shared") return { kind: "success", text: "Shared. Choose ChatGPT in Android's share sheet." };
  if (outcome === "copied") return { kind: "success", text: "Prompt copied. Paste it into the ChatGPT app." };
  return { kind: "warning", text: "Sharing was cancelled. Your retrieved sources are still ready below." };
}

function formatBytes(value: number): string {
  if (!value) return "0 MB";
  if (value < 1_000_000) return Math.ceil(value / 1_000) + " KB";
  return (value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0) + " MB";
}

function StatusPill({ memory }: { memory: LocalMemory }) {
  const labels: Record<LocalMemory["processingStatus"], string> = {
    pending: "Pending",
    processing: "Processing",
    ready: "Ready",
    needs_review: "Review",
    failed: "Failed",
  };
  return <span className={"status status-" + memory.processingStatus}>{labels[memory.processingStatus]}</span>;
}

function MemoryCard({ memory, compact = false, citation, onOpen, onShare, onRetry, onDelete, onLabel }: {
  memory: LocalMemory;
  compact?: boolean;
  citation?: number;
  onOpen?: (memory: LocalMemory) => void;
  onShare?: (memory: LocalMemory) => void;
  onRetry?: (memory: LocalMemory) => void;
  onDelete?: (memory: LocalMemory) => void;
  onLabel?: (memory: LocalMemory, label: string) => Promise<void>;
}) {
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(memory.title || "");
  const [savingLabel, setSavingLabel] = useState(false);

  async function submitLabel(event: FormEvent) {
    event.preventDefault();
    const value = labelDraft.trim();
    if (!value || !onLabel) return;
    setSavingLabel(true);
    try {
      await onLabel(memory, value);
      setEditingLabel(false);
    } catch { /* The parent notice keeps the editor open for another try. */ }
    finally { setSavingLabel(false); }
  }

  return (
    <article className={"memory-card" + (compact ? " compact" : "")}>
      <div className="memory-topline">
        <span className="memory-type">{citation && <b className="citation-number">[{citation}]</b>}<Icon name={memory.type === "url" ? "link" : "note"} size={15}/>{memory.category}</span>
        <StatusPill memory={memory}/>
      </div>
      <h3>{memory.title || (memory.processingStatus === "pending" ? "Waiting to process..." : "Untitled memory")}</h3>
      <p>{memory.description || memory.rawInput}</p>
      <div className="memory-meta">
        <span>{memory.sourceDomain || new Date(memory.createdAt).toLocaleDateString()}</span>
        {memory.tags.slice(0, 3).map((tag) => <span className="tag" key={tag}>#{tag}</span>)}
      </div>
      {editingLabel && <form className="label-editor" onSubmit={submitLabel}>
        <input aria-label="Memory label" autoFocus maxLength={120} value={labelDraft} onChange={(event) => setLabelDraft(event.target.value)}/>
        <button className="button primary" disabled={savingLabel || !labelDraft.trim()} type="submit">{savingLabel ? "Saving" : "Save"}</button>
        <button className="button secondary" disabled={savingLabel} type="button" onClick={() => setEditingLabel(false)}>Cancel</button>
      </form>}
      {memory.processingError && <div className="review-note">{memory.processingError}</div>}
      <div className="card-actions">
        {memory.originalUrl && <a className="review-action" href={memory.originalUrl} target="_blank" rel="noreferrer"><Icon name="external" size={16}/>Open source</a>}
        {memory.originalFilePath && onOpen && <button className="review-action" onClick={() => onOpen(memory)} type="button"><Icon name="external" size={16}/>Open file</button>}
        {onShare && <button className="review-action" onClick={() => onShare(memory)} type="button"><Icon name="share" size={16}/>Share</button>}
        {onRetry && memory.processingStatus !== "ready" && <button className="review-action" onClick={() => onRetry(memory)} type="button"><Icon name="refresh" size={16}/>Try again</button>}
        {onLabel && !editingLabel && <button className="review-action" onClick={() => { setLabelDraft(memory.title || ""); setEditingLabel(true); }} type="button">Edit label</button>}
        {!compact && onDelete && <button className="review-action danger-action" onClick={() => onDelete(memory)} type="button"><Icon name="trash" size={16}/>Delete</button>}
      </div>
    </article>
  );
}

export function MemoryApp() {
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "capture";
    const saved = localStorage.getItem(TAB_STORAGE) as Tab | null;
    return saved && ["capture", "inbox", "library", "ask"].includes(saved) ? saved : "capture";
  });
  const [input, setInput] = useState("");
  const [label, setLabel] = useState("");
  const [memories, setMemories] = useState<LocalMemory[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [question, setQuestion] = useState("");
  const [recall, setRecall] = useState<{ question: string; results: RagResult[]; packet: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [accessKey, setAccessKey] = useState("");
  const [storage, setStorage] = useState<LocalStorageStatus | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const sharedInputRef = useRef(false);
  const keyRef = useRef("");
  const hasNavigated = useRef(false);

  const switchTab = useCallback((next: Tab) => {
    setTab(next);
    localStorage.setItem(TAB_STORAGE, next);
  }, []);

  const refresh = useCallback(async () => {
    setMemories(await localMemory.list({ limit: 10_000 }));
  }, []);

  const refreshStorage = useCallback(async () => {
    setStorage(await localMemory.storageStatus());
  }, []);

  const resumeProcessing = useCallback(async (key = keyRef.current) => {
    const candidates = (await localMemory.list({ limit: 10_000 }))
      .filter((memory) => ["pending", "processing"].includes(memory.processingStatus) || memory.type === "note" && !memory.description);
    for (const memory of candidates) await processMemory(memory, key);
    await refresh();
  }, [refresh]);

  useEffect(() => {
    if (!hasNavigated.current) {
      hasNavigated.current = true;
      return;
    }
    document.querySelector<HTMLElement>("#main-content h1")?.focus();
  }, [tab]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shared = params.get("url") || params.get("text") || params.get("title") || sessionStorage.getItem(SHARED_INPUT_KEY);
    if (!shared) return;
    const timer = window.setTimeout(() => {
      sharedInputRef.current = true;
      setInput(shared);
      switchTab("capture");
      sessionStorage.setItem(SHARED_INPUT_KEY, shared);
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.hash);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [switchTab]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await localMemory.initialize();
        let key = await localMemory.getSetting(ACCESS_KEY_SETTING, "");
        if (!key) {
          key = localStorage.getItem("sockdrawer-access-key") || localStorage.getItem("memoria-key") || "";
          if (key) await localMemory.setSetting(ACCESS_KEY_SETTING, key);
        }
        if (cancelled) return;
        keyRef.current = key;
        setAccessKey(key);
        await refresh();
        await refreshStorage();
        void localMemory.requestPersistence().then(refreshStorage);
        void resumeProcessing(key);
      } catch (error) {
        if (!cancelled) setNotice({ kind: "error", text: error instanceof Error ? error.message : "Phone storage could not be opened." });
      }
    })();
    return () => { cancelled = true; };
  }, [refresh, refreshStorage, resumeProcessing]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then(warmOfflineShell)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const online = () => void resumeProcessing();
    const visible = () => { if (document.visibilityState === "visible") void resumeProcessing(); };
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [resumeProcessing]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const value = input.trim();
    if (!value) return;
    if (value.length > MAX_CAPTURE_CHARS) {
      setNotice({ kind: "error", text: "Keep a capture under 100,000 characters." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await localMemory.captureText(value, { title: label.trim() || undefined });
      setInput("");
      setLabel("");
      if (sharedInputRef.current) {
        sharedInputRef.current = false;
        sessionStorage.removeItem(SHARED_INPUT_KEY);
      }
      setNotice(result.duplicate
        ? { kind: "warning", text: "Already saved on this phone." }
        : { kind: "success", saved: true, text: result.memory.type === "url" && !keyRef.current ? "Saved on this phone. Add the link-reader key in Review when ready." : "Saved safely on this phone." });
      await refresh();
      if (!result.duplicate) void processMemory(result.memory, keyRef.current).then(refresh);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not save. Your text is still here." });
    } finally {
      setBusy(false);
    }
  }

  async function uploadFile(file: File | null) {
    if (!file) return;
    if (fileInputRef.current) fileInputRef.current.value = "";
    setBusy(true);
    setNotice(null);
    try {
      const result = await localMemory.captureFile(file, { title: label.trim() || undefined });
      if (!result.duplicate) setLabel("");
      setNotice(result.duplicate ? { kind: "warning", text: "That file is already saved on this phone." } : { kind: "success", saved: true, text: "File saved safely on this phone." });
      await refresh();
      if (!result.duplicate) void processMemory(result.memory, keyRef.current).then(refresh);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The file could not be saved." });
    } finally {
      setBusy(false);
    }
  }

  async function retryMemory(memory: LocalMemory) {
    await localMemory.update(memory.id, { processingStatus: "pending", processingError: null });
    await refresh();
    void processMemory(memory, keyRef.current).then(refresh);
  }

  async function renameMemory(memory: LocalMemory, nextLabel: string) {
    try {
      if (!await localMemory.update(memory.id, { title: nextLabel })) throw new Error("The saved item could not be found.");
      await refresh();
      setNotice({ kind: "success", text: "Label updated on this phone." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The label could not be updated." });
      throw error;
    }
  }

  async function deleteMemory(memory: LocalMemory) {
    if (!confirm('Delete "' + (memory.title || memory.rawInput.slice(0, 60)) + '" from this phone?')) return;
    await localMemory.delete(memory.id);
    setNotice({ kind: "success", text: "Deleted from this phone." });
    await refresh();
    await refreshStorage();
  }

  async function openMemory(memory: LocalMemory) {
    try {
      if (!await localMemory.openOriginal(memory.id)) throw new Error("The original file could not be opened.");
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The file could not be opened." });
    }
  }

  async function shareMemory(memory: LocalMemory) {
    const result: RagResult = { citation: 1, memory, chunkId: memory.id + ":share", excerpt: memory.content.slice(0, 12_000), score: 1 };
    const packet = buildChatGptPacket("Help me understand this saved item.", [result]);
    try { setNotice(shareNotice(await shareOrCopy("SockDrawer: " + (memory.title || "saved item"), packet))); }
    catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not share this item." }); }
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    const value = question.trim();
    if (!value) return;
    setAsking(true);
    setNotice(null);
    try {
      const results = await rag.retrieve(value);
      const packet = buildChatGptPacket(value, results, memories);
      setRecall({ question: value, results, packet });
      setNotice(shareNotice(await shareOrCopy("Ask ChatGPT with SockDrawer", packet)));
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not prepare the ChatGPT prompt." });
    } finally {
      setAsking(false);
    }
  }

  function askKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function shareRecall() {
    if (!recall) return;
    try { setNotice(shareNotice(await shareOrCopy("Ask ChatGPT with SockDrawer", recall.packet))); }
    catch (error) { setNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not share the prompt." }); }
  }

  async function saveAccessKey(event: FormEvent) {
    event.preventDefault();
    const key = accessKey.trim();
    await localMemory.setSetting(ACCESS_KEY_SETTING, key);
    keyRef.current = key;
    setAccessKey(key);
    setNotice({ kind: "success", text: key ? "Link reader connected on this phone." : "Link reader key removed." });
    if (key) void resumeProcessing(key);
  }

  async function protectStorage() {
    const persisted = await localMemory.requestPersistence();
    await refreshStorage();
    setNotice(persisted
      ? { kind: "success", text: "Chrome will protect SockDrawer data from automatic cleanup." }
      : { kind: "warning", text: "Chrome did not grant protected storage yet. Keep regular backups." });
  }

  async function exportBackup() {
    setBusy(true);
    try {
      const blob = await localMemory.exportBackup();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "sockdrawer-backup-" + new Date().toISOString().slice(0, 10) + ".json";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      await refreshStorage();
      setNotice({ kind: "success", text: "Complete backup downloaded. Keep it somewhere safe." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Backup failed." });
    } finally {
      setBusy(false);
    }
  }

  async function importBackup(file: File | null) {
    if (!file) return;
    if (backupInputRef.current) backupInputRef.current.value = "";
    setBusy(true);
    try {
      const result = await localMemory.importBackup(file);
      await refresh();
      await refreshStorage();
      setNotice({ kind: "success", text: "Recovered " + result.imported + " saved items on this phone." });
      void resumeProcessing();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Backup import failed." });
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    if (!confirm("Delete every SockDrawer item and stored file from this phone? Export a backup first.")) return;
    await localMemory.clear();
    setRecall(null);
    await refresh();
    await refreshStorage();
    setNotice({ kind: "success", text: "All saved material was removed from this phone." });
  }

  const categories = useMemo(() => [...new Set(memories.map((memory) => memory.category))].sort(), [memories]);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return memories.filter((memory) => !category || memory.category === category).filter((memory) => {
      if (!query) return true;
      return [memory.title, memory.description, memory.rawInput, memory.content, memory.tags.join(" ")]
        .some((value) => value?.toLocaleLowerCase().includes(query));
    });
  }, [category, memories, search]);
  const inbox = useMemo(() => memories.filter((memory) => memory.processingStatus !== "ready"), [memories]);
  const readyCount = memories.filter((memory) => memory.processingStatus === "ready").length;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to study content</a>
      <aside className="rail">
        <a className="brand" href="#main-content" aria-label="SockDrawer study home"><span className="brand-mark"><Icon name="sock" size={23}/></span><span>Sock<span>Drawer</span></span></a>
        <nav aria-label="Main navigation">
          <NavButton active={tab === "capture"} icon="spark" label="Save" onClick={() => switchTab("capture")}/>
          <NavButton active={tab === "inbox"} icon="inbox" label="Review" count={inbox.length} onClick={() => switchTab("inbox")}/>
          <NavButton active={tab === "library"} icon="library" label="Library" onClick={() => switchTab("library")}/>
          <NavButton active={tab === "ask"} icon="ask" label="Recall" onClick={() => switchTab("ask")}/>
        </nav>
        <button className="access-button" type="button" onClick={() => switchTab("inbox")}><Icon name="lock" size={17}/> Phone storage</button>
      </aside>

      <main id="main-content">
        {notice && <div className={"notice global-notice " + notice.kind} role={notice.kind === "error" ? "alert" : "status"} aria-live="polite">{notice.saved ? <SaveDrawerMark/> : <Icon name={notice.kind === "success" ? "sock" : notice.kind === "warning" ? "warning" : "error"} size={17}/>}<span>{notice.text}</span></div>}

        {tab === "capture" && <section className="page capture-page">
          <header className="page-header">
            <h1 tabIndex={-1}>Remember what you <em>learn.</em></h1>
            <p>Save an article, note, or file now. SockDrawer keeps it in your phone and finds it later.</p>
          </header>
          <form className="capture-card" onSubmit={save}>
            <div className="capture-fields">
              <textarea aria-label="Study material" value={input} onChange={(event) => {
                const value = event.target.value;
                setInput(value);
                if (sharedInputRef.current) {
                  if (value) sessionStorage.setItem(SHARED_INPUT_KEY, value);
                  else sessionStorage.removeItem(SHARED_INPUT_KEY);
                }
              }} placeholder="Paste a lecture note, link, or study idea..." rows={5}/>
              <input aria-label="Label for recall" maxLength={120} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Label for recall (optional)"/>
            </div>
            <div className="capture-actions">
              <span><Icon name={input.trim().startsWith("http") ? "link" : "note"} size={17}/>{input.trim().startsWith("http") ? "Source link detected" : "Study note"}</span>
              <label className="button secondary file-button">Add material<input ref={fileInputRef} type="file" onChange={(event) => void uploadFile(event.target.files?.[0] || null)} disabled={busy}/></label>
              <button className="button primary send-button" disabled={busy || !input.trim()} type="submit">{busy ? "Saving" : "Save material"}<Icon name="send" size={17}/></button>
            </div>
          </form>
          {(readyCount > 0 || inbox.length > 0) && <div className="summary-grid">
            <div><strong className="tabular">{readyCount}</strong><span>materials ready to recall</span></div>
            <div><strong className="tabular">{inbox.length}</strong><span>being processed or reviewed</span></div>
            <div><strong className="tabular">{formatBytes(storage?.usage || 0)}</strong><span>used in Chrome storage</span></div>
          </div>}
          {!memories.length && <section className="study-flow" aria-label="How SockDrawer supports study">
            <div className="study-step"><span>01</span><div><strong>Collect</strong><p>Drop in the material before it disappears.</p></div></div>
            <div className="study-step"><span>02</span><div><strong>Keep local</strong><p>Your library stays in Chrome storage on this phone.</p></div></div>
            <div className="study-step"><span>03</span><div><strong>Recall</strong><p>Retrieve sources locally, then share them to ChatGPT.</p></div></div>
          </section>}
          <section className="recent-section">
            <div className="section-heading"><h2>Recent material</h2><button className="icon-button" type="button" aria-label="Refresh materials" onClick={() => void resumeProcessing()}><Icon name="refresh"/></button></div>
            <div className="memory-grid">{memories.slice(0, 4).map((memory) => <MemoryCard memory={memory} onOpen={openMemory} onShare={shareMemory} key={memory.id}/>)}</div>
            {!memories.length && <EmptyState title="Your study space is ready" text="Your first saved source, note, or file will appear here."/>}
          </section>
        </section>}

        {tab === "inbox" && <section className="page">
          <PageTitle title="Review & backup" text="Pending material and the controls that keep your phone library durable live here."/>
          <section className="storage-card">
            <div className="storage-heading"><h2>{storage?.persisted ? "Protected on this phone" : "Back up this phone"}</h2><strong className="tabular">{formatBytes(storage?.usage || 0)}{storage?.quota ? " / " + formatBytes(storage.quota) : ""}</strong></div>
            <progress className="storage-meter" max="100" value={Math.min(storage?.percentUsed || 0, 100)} aria-label={(storage?.percentUsed || 0).toFixed(1) + "% of browser quota used"}/>
            <p>{storage?.lastBackupAt ? "Last backup: " + new Date(storage.lastBackupAt).toLocaleString() : "No backup exported yet."} Originals, archives, indexes, and records are included.</p>
            <div className="storage-actions">
              <button className="button secondary" type="button" onClick={() => void protectStorage()}><Icon name="lock" size={17}/>Protect storage</button>
              <button className="button secondary" type="button" onClick={() => void exportBackup()} disabled={busy}><Icon name="download" size={17}/>Export backup</button>
              <label className="button secondary file-button"><Icon name="upload" size={17}/>Import backup<input ref={backupInputRef} type="file" accept="application/json,.json" onChange={(event) => void importBackup(event.target.files?.[0] || null)} disabled={busy}/></label>
              <button className="button secondary danger-action" type="button" onClick={() => void clearAll()} disabled={busy}><Icon name="trash" size={17}/>Clear library</button>
            </div>
          </section>
          <form className="access-panel local-access" onSubmit={saveAccessKey}>
            <div><h2>Public link reader</h2><p>Needed only to extract public webpages. The key stays in this phone&apos;s local database.</p></div>
            <div className="key-form"><input aria-label="Vercel link reader access key" type="password" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} placeholder="MEMORIA_ACCESS_KEY" autoComplete="off"/><button className="button primary" type="submit">Save key</button></div>
          </form>
          <div className="memory-grid">{inbox.map((memory) => <MemoryCard memory={memory} onOpen={openMemory} onShare={shareMemory} onRetry={retryMemory} onLabel={renameMemory} key={memory.id}/>)}</div>
          {!inbox.length && <EmptyState title="Review desk clear" text="Everything saved on this phone is ready to retrieve."/>}
        </section>}

        {tab === "library" && <section className="page">
          <PageTitle title="Materials" text="Search notes, extracted text, tags, and titles without sending your library online."/>
          <div className="filter-bar">
            <label className="search-field"><Icon name="search"/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search saved material..." aria-label="Search saved materials"/></label>
            <select aria-label="Filter by subject" value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All subjects</option>{categories.map((name) => <option key={name}>{name}</option>)}</select>
          </div>
          <div className="memory-grid">{filtered.map((memory) => <MemoryCard memory={memory} onOpen={openMemory} onShare={shareMemory} onDelete={deleteMemory} onLabel={renameMemory} key={memory.id}/>)}</div>
          {!filtered.length && <EmptyState title="No matching material" text="Try a broader phrase or remove the subject filter."/>}
        </section>}

        {tab === "ask" && <section className="page ask-page">
          <PageTitle title="Ask ChatGPT with sources" text="SockDrawer finds the best sources on this phone, then opens Android's share sheet with a grounded prompt."/>
          <div className="conversation" aria-live="polite">
            {!recall && !asking && <div className="ask-prompt">
              <span className="brand-mark large"><Icon name="sock" size={29}/></span>
              <h2>What do you want to understand?</h2>
              <p>Your library stays local. Only the selected excerpts you share are sent to ChatGPT.</p>
              <div className="suggested-prompts"><span>Try a starter</span><div>{STUDY_PROMPTS.map((prompt) => <button className="prompt-chip" key={prompt} type="button" onClick={() => setQuestion(prompt)}>{prompt}</button>)}</div></div>
            </div>}
            {recall && <div className="turn">
              <div className="question-bubble">{recall.question}</div>
              <div className="answer-bubble source-preview">
              <div><h2>{recall.results.length ? recall.results.length + " local sources found" : "No matching sources found"}</h2><p>{recall.results.length ? "Review the excerpts, then choose ChatGPT from the Android share sheet." : "The shared prompt tells ChatGPT that the evidence is insufficient."}</p></div>
                <button className="button primary" type="button" onClick={() => void shareRecall()}><Icon name="share" size={18}/>Ask ChatGPT</button>
                <div className="citations">{recall.results.map((result) => <MemoryCard memory={result.memory as LocalMemory} compact citation={result.citation} onOpen={openMemory} onShare={shareMemory} key={result.memory.id}/>)}</div>
              </div>
            </div>}
            {asking && <div className="turn"><div className="question-bubble thinking"><Icon name="spinner" size={16}/>Finding sources on this phone...</div></div>}
          </div>
          <form className="ask-form" onSubmit={ask}>
            <textarea aria-label="Question for your saved material" rows={2} value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={askKeyDown} placeholder="Ask your saved material..."/>
            <button className="button primary" disabled={asking || !question.trim()} aria-label="Retrieve and ask ChatGPT" type="submit">{asking ? <Icon name="spinner" size={18}/> : <Icon name="send"/>}</button>
          </form>
        </section>}
      </main>

      <nav className="bottom-nav" aria-label="Mobile navigation">
        <NavButton active={tab === "capture"} icon="spark" label="Save" onClick={() => switchTab("capture")}/>
        <NavButton active={tab === "inbox"} icon="inbox" label="Review" count={inbox.length} onClick={() => switchTab("inbox")}/>
        <NavButton active={tab === "library"} icon="library" label="Library" onClick={() => switchTab("library")}/>
        <NavButton active={tab === "ask"} icon="ask" label="Recall" onClick={() => switchTab("ask")}/>
      </nav>
    </div>
  );
}

function NavButton({ active, icon, label, count, onClick }: { active: boolean; icon: "spark" | "inbox" | "library" | "ask"; label: string; count?: number; onClick: () => void }) {
  return <button className={active ? "active" : ""} type="button" aria-current={active ? "page" : undefined} onClick={onClick}><span className="nav-icon"><Icon name={icon}/>{Boolean(count) && <b className="tabular">{count}</b>}</span><span>{label}</span></button>;
}

function PageTitle({ title, text }: { title: string; text: string }) {
  return <header className="page-title"><h1 tabIndex={-1}>{title}</h1><p>{text}</p></header>;
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><span className="brand-mark"><Icon name="sock"/></span><h3>{title}</h3><p>{text}</p></div>;
}
