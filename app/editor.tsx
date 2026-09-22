"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { streamZipToDisk, supportsStreamingZip } from "../lib/stream-zip-client";

const ratios = ["default", "1:1", "3:2", "2:3", "9:16", "16:9", "3:4", "4:3"];
const MAX_BATCH = 50;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const BATCH_PIPELINE_CONCURRENCY = 8;
const BATCH_UPLOAD_CONCURRENCY = 2;
const HISTORY_TTL_MS = 60 * 60 * 1000;
const APP_VERSION = "1.5.3";
const APP_VERSION_KEY = "pixora-app-version";

type Mode = "single" | "batch" | "reference";
type OutputTab = "result" | "history";
type ProgressState = { percent: number; label: string; state: "idle" | "working" | "done" | "error" | "stopped" };
type GenerationStage = "idle" | "uploading" | "submitting" | "processing";
type HistoryItem = { url: string; previewUrl?: string; prompt: string; createdAt: string };
type BatchStatus = "ready" | "uploading" | "queued" | "processing" | "done" | "failed" | "stopped";
type BatchItem = {
  id: string;
  file?: File;
  preview: string;
  uploadedUrl?: string;
  taskId?: string;
  result?: string;
  resultPreview?: string;
  error?: string;
  progress: number;
  label: string;
  status: BatchStatus;
};

type RatioPickerProps = { value: string; onChange: (value: string) => void };

function RatioPicker({ value, onChange }: RatioPickerProps) {
  return <div className="ratioPanel">
    <div className="ratioLabel"><div><span>OUTPUT FORMAT</span><small>Choose the perfect canvas</small></div><strong>{value === "default" ? "Original" : value}</strong></div>
    <div className="ratios">{ratios.map((item) => <button type="button" key={item} className={value === item ? "active" : ""} onClick={() => onChange(item)} aria-label={`Use ${item === "default" ? "original" : item} aspect ratio`}><i className={`ratioShape ratio-${item.replace(":", "x")}`} />{item === "default" ? "Auto" : item}</button>)}</div>
  </div>;
}

function ProgressBar({ progress }: { progress: ProgressState }) {
  if (progress.state === "idle" && progress.percent === 0) return null;
  const percent = Math.max(0, Math.min(100, progress.percent));
  return <div className={`progressBox ${progress.state}`} aria-live="polite">
    <div className="progressTop"><span>{progress.label}</span><strong>{Math.round(percent)}%</strong></div>
    <div className="progressTrack"><i style={{ width: `${percent}%` }} /></div>
  </div>;
}

function UploadEmpty({ title, subtitle, button = "Choose image" }: { title: string; subtitle: string; button?: string }) {
  return <div className="uploadEmpty"><span className="uploadIcon">↥</span><h3>{title}</h3><p>{subtitle}</p><button type="button">{button}</button></div>;
}

function PreserveControls({ preserveFace, preservePose, onFace, onPose }: { preserveFace: boolean; preservePose: boolean; onFace: (value: boolean) => void; onPose: (value: boolean) => void }) {
  return <div className="preservePanel">
    <div className="preserveHead"><div><span>SUBJECT LOCK</span><small>Ask V-Editor to keep identity and composition stable</small></div></div>
    <div className="preserveOptions">
      <label className={preserveFace ? "active" : ""}><span><b>Same face</b><small>Preserve facial identity</small></span><input type="checkbox" checked={preserveFace} onChange={(event) => onFace(event.target.checked)} /><i /></label>
      <label className={preservePose ? "active" : ""}><span><b>Same pose</b><small>Preserve pose & framing</small></span><input type="checkbox" checked={preservePose} onChange={(event) => onPose(event.target.checked)} /><i /></label>
    </div>
  </div>;
}

function validImage(file?: File | null) {
  return Boolean(file && ["image/png", "image/jpeg", "image/webp"].includes(file.type) && file.size <= MAX_FILE_BYTES);
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

function applyPreservation(prompt: string, preserveFace: boolean, preservePose: boolean, referenceMode = false) {
  const constraints: string[] = [];
  if (preserveFace) constraints.push("Preserve the exact facial identity of every person from the main/input image: keep facial structure, features, skin tone, age, hairstyle, and recognizable identity unchanged. Do not replace, redesign, beautify, or morph the face.");
  if (preservePose) constraints.push("Preserve the exact body pose, limb positions, camera angle, crop, framing, and composition of the main/input image. Do not change the pose unless the requested edit makes it physically impossible.");
  if (referenceMode && constraints.length) constraints.push("Use the reference image only as visual guidance; do not copy the reference person's identity or pose over the main subject when those locks are enabled.");
  return constraints.length ? `${prompt.trim()}\n\nImportant preservation constraints: ${constraints.join(" ")}` : prompt.trim();
}

function displayImageUrl(url: string, width = 720, quality = 86) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("imagekit.io")) return url;
    const current = parsed.searchParams.get("tr");
    const resize = `w-${Math.max(120, Math.min(1800, Math.round(width)))},q-${Math.max(70, Math.min(95, Math.round(quality)))}`;
    parsed.searchParams.set("tr", current ? `${current},${resize}` : resize);
    return parsed.toString();
  } catch {
    return url;
  }
}

function originalImageUrl(url: string) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("imagekit.io")) return url;
    parsed.searchParams.set("tr", "orig-true");
    return parsed.toString();
  } catch {
    return url;
  }
}

export default function Editor() {
  const singleInputRef = useRef<HTMLInputElement>(null);
  const batchInputRef = useRef<HTMLInputElement>(null);
  const referenceMainRef = useRef<HTMLInputElement>(null);
  const referenceStyleRef = useRef<HTMLInputElement>(null);

  const [mode, setMode] = useState<Mode>("single");
  const [outputTab, setOutputTab] = useState<OutputTab>("result");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [totalGenerated, setTotalGenerated] = useState<number | null>(null);
  const [preserveFace, setPreserveFace] = useState(false);
  const [preservePose, setPreservePose] = useState(false);

  const [singleFile, setSingleFile] = useState<File | null>(null);
  const [singlePreview, setSinglePreview] = useState("");
  const [singlePrompt, setSinglePrompt] = useState("");
  const [singleRatio, setSingleRatio] = useState("default");
  const [singleBusy, setSingleBusy] = useState(false);
  const [singleStopRequested, setSingleStopRequested] = useState(false);
  const singleStopRequestedRef = useRef(false);
  const singleStageRef = useRef<GenerationStage>("idle");
  const singleUploadAbortRef = useRef<AbortController | null>(null);
  const [singleResult, setSingleResult] = useState("");
  const [singleResultPreview, setSingleResultPreview] = useState("");
  const [singleMessage, setSingleMessage] = useState("");
  const [singleProgress, setSingleProgress] = useState<ProgressState>({ percent: 0, label: "", state: "idle" });

  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [batchPrompt, setBatchPrompt] = useState("");
  const [batchRatio, setBatchRatio] = useState("default");
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchStopRequested, setBatchStopRequested] = useState(false);
  const batchStopRequestedRef = useRef(false);
  const [batchMessage, setBatchMessage] = useState("");
  const [batchDownloading, setBatchDownloading] = useState(false);
  const batchItemsRef = useRef<BatchItem[]>([]);
  const batchUploadPromisesRef = useRef(new Map<string, Promise<string>>());
  const batchUploadQueueRef = useRef<Array<() => void>>([]);
  const activeBatchUploadsRef = useRef(0);
  const batchUploadProgressRef = useRef(new Map<string, { percent: number; at: number }>());

  const [referenceMain, setReferenceMain] = useState<File | null>(null);
  const [referenceMainPreview, setReferenceMainPreview] = useState("");
  const [referenceImage, setReferenceImage] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState("");
  const [referencePrompt, setReferencePrompt] = useState("");
  const [referenceRatio, setReferenceRatio] = useState("default");
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [referenceStopRequested, setReferenceStopRequested] = useState(false);
  const referenceStopRequestedRef = useRef(false);
  const referenceStageRef = useRef<GenerationStage>("idle");
  const referenceUploadAbortRef = useRef<AbortController | null>(null);
  const [referenceResult, setReferenceResult] = useState("");
  const [referenceResultPreview, setReferenceResultPreview] = useState("");
  const [referenceMessage, setReferenceMessage] = useState("");
  const [referenceProgress, setReferenceProgress] = useState<ProgressState>({ percent: 0, label: "", state: "idle" });

  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [downloadMenu, setDownloadMenu] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<ProgressState>({ percent: 0, label: "", state: "idle" });
  const [downloadedUrls, setDownloadedUrls] = useState<string[]>([]);
  const [downloadNoticeUrl, setDownloadNoticeUrl] = useState("");
  const [viewerUrls, setViewerUrls] = useState<string[]>([]);
  const [viewerPreviewUrls, setViewerPreviewUrls] = useState<string[]>([]);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [pendingUndo, setPendingUndo] = useState<{ item: HistoryItem; index: number } | null>(null);
  const [versionNotice, setVersionNotice] = useState(false);
  const [accountEmail, setAccountEmail] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const historyDeletePromisesRef = useRef(new Map<string, Promise<unknown>>());
  const swipeStart = useRef<number | null>(null);
  const undoSwipeStart = useRef<number | null>(null);
  const undoTimerRef = useRef<number | null>(null);

  const isProcessing = singleBusy || batchBusy || referenceBusy;

  useEffect(() => {
    const previous = localStorage.getItem(APP_VERSION_KEY);
    localStorage.setItem(APP_VERSION_KEY, APP_VERSION);
    if (previous !== APP_VERSION) {
      setVersionNotice(true);
      const timer = window.setTimeout(() => setVersionNotice(false), 5000);
      return () => window.clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    const prune = () => {
      const saved = localStorage.getItem("pixora-history");
      const hiddenSaved = localStorage.getItem("pixora-history-hidden");
      const cutoff = Date.now() - HISTORY_TTL_MS;
      let parsed: HistoryItem[] = [];
      let hidden: string[] = [];
      try { parsed = saved ? JSON.parse(saved) as HistoryItem[] : []; } catch { parsed = []; }
      try { hidden = hiddenSaved ? JSON.parse(hiddenSaved) as string[] : []; } catch { hidden = []; }
      const hiddenUrls = new Set(hidden);
      const fresh = parsed
        .filter((item) => new Date(item.createdAt).getTime() > cutoff && !hiddenUrls.has(item.url))
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
      setHistory(fresh);
      localStorage.setItem("pixora-history", JSON.stringify(fresh));
    };

    prune();
    const timer = window.setInterval(prune, 60_000);

    fetch("/api/stats", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data: { totalGenerated?: number }) => {
        if (typeof data.totalGenerated === "number") setTotalGenerated(data.totalGenerated);
      })
      .catch(() => undefined);

    fetch("/api/auth", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data: { authenticated?: boolean; account?: { email?: string } | null }) => {
        const email = data.authenticated ? String(data.account?.email || "") : "";
        setAccountEmail(email);
        if (email) void syncAndLoadAccountHistory();
      })
      .catch(() => undefined);

    return () => {
      window.clearInterval(timer);
      if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    };
  }, []);

  const batchOverall = useMemo(() => batchItems.length ? Math.round(batchItems.reduce((sum, item) => sum + item.progress, 0) / batchItems.length) : 0, [batchItems]);
  const batchDone = batchItems.filter((item) => item.status === "done").length;
  const batchFailed = batchItems.filter((item) => item.status === "failed").length;
  const batchStopped = batchItems.filter((item) => item.status === "stopped").length;
  const batchUploaded = batchItems.filter((item) => item.uploadedUrl).length;
  const batchResults = batchItems.filter((item) => item.result).map((item) => item.result!);
  const batchProgress: ProgressState = batchItems.length && (batchBusy || batchOverall > 0) ? {
    percent: batchOverall,
    state: batchBusy ? "working" : batchStopped > 0 ? "stopped" : batchFailed === batchItems.length ? "error" : batchDone > 0 ? "done" : "idle",
    label: batchBusy
      ? batchStopRequested
        ? `Stopping safely · ${batchDone} completed${batchFailed ? ` · ${batchFailed} failed` : ""}`
        : `${batchDone} of ${batchItems.length} completed${batchFailed ? ` · ${batchFailed} failed` : ""}`
      : batchStopped
        ? `Stopped · ${batchDone} completed · ${batchStopped} not processed`
        : batchDone === batchItems.length
          ? `All ${batchDone} images completed`
          : `${batchUploaded}/${batchItems.length} uploaded · generation not started`,
  } : { percent: 0, label: "", state: "idle" };

  useEffect(() => {
    batchItemsRef.current = batchItems;
  }, [batchItems]);

  function freshHistoryItems(items: HistoryItem[]) {
    const cutoff = Date.now() - HISTORY_TTL_MS;
    return Array.from(
      new Map(
        items
          .filter((item) => item?.url && new Date(item.createdAt).getTime() > cutoff)
          .map((item) => [item.url, item]),
      ).values(),
    ).sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  }

  function localHistoryItems() {
    try {
      return freshHistoryItems(JSON.parse(localStorage.getItem("pixora-history") || "[]") as HistoryItem[]);
    } catch {
      return [];
    }
  }

  function storeHistory(items: HistoryItem[]) {
    const fresh = freshHistoryItems(items);
    setHistory(fresh);
    localStorage.setItem("pixora-history", JSON.stringify(fresh));
    return fresh;
  }

  async function saveSyncedHistoryItem(item: HistoryItem) {
    const response = await fetch("/api/account-history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item),
    });
    if (response.status === 401) setAccountEmail("");
    return response.ok;
  }

  async function syncAndLoadAccountHistory() {
    const local = localHistoryItems();

    if (local.length) {
      await Promise.allSettled(local.map((item) => saveSyncedHistoryItem(item)));
    }

    const response = await fetch("/api/account-history", { cache: "no-store" });
    if (!response.ok) {
      if (response.status === 401) setAccountEmail("");
      return;
    }

    const data = await response.json() as { history?: HistoryItem[] };
    const remote = Array.isArray(data.history) ? data.history : [];
    localStorage.removeItem("pixora-history-hidden");
    setSelected([]);
    storeHistory([...remote, ...local]);
  }

  async function submitAccount() {
    if (authBusy) return;
    setAuthBusy(true);
    setAuthMessage("");
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: authEmail, password: authPassword }),
      });
      const data = await response.json() as { account?: { email?: string }; created?: boolean; error?: string };
      if (!response.ok || !data.account?.email) throw new Error(data.error || "Could not sign in.");

      setAccountEmail(data.account.email);
      setAuthEmail(data.account.email);
      setAuthPassword("");
      await syncAndLoadAccountHistory();
      setAuthMessage(data.created ? "Account created and history synced." : "Signed in and history synced.");
      window.setTimeout(() => {
        setAuthOpen(false);
        setAuthMessage("");
      }, 700);
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "Could not sign in.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOutAccount() {
    if (isProcessing) return;
    await fetch("/api/auth", { method: "DELETE" }).catch(() => undefined);
    setAccountEmail("");
    setAuthOpen(false);
    setAuthEmail("");
    setAuthPassword("");
    setAuthMessage("");
    localStorage.removeItem("pixora-history");
    localStorage.removeItem("pixora-history-hidden");
    setHistory([]);
    setSelected([]);
    setOutputTab("result");
  }

  function addHistory(url: string, prompt: string, incrementGenerationCount = true, previewUrl = "") {
    const item: HistoryItem = { url, previewUrl: previewUrl || undefined, prompt, createdAt: new Date().toISOString() };
    setHistory((current) => {
      const next = freshHistoryItems([item, ...current]);
      localStorage.setItem("pixora-history", JSON.stringify(next));
      return next;
    });
    if (accountEmail) void saveSyncedHistoryItem(item);
    if (incrementGenerationCount) {
      setTotalGenerated((current) => current === null ? current : current + 1);
    }
  }

  async function uploadImage(image: File, onProgress?: (percentage: number) => void, signal?: AbortSignal) {
    const blob = await upload(`pixora-inputs/${Date.now()}-${crypto.randomUUID()}-${image.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`, image, {
      access: "public",
      handleUploadUrl: "/api/upload",
      signal,
      onUploadProgress(event) { onProgress?.(event.percentage); },
    });
    return blob.url;
  }

  function validateFile(next?: File) {
    if (!next) return "No image selected.";
    if (!["image/png", "image/jpeg", "image/webp"].includes(next.type)) return "Use a PNG, JPG, or WEBP image.";
    if (next.size > MAX_FILE_BYTES) return "Each image must be 12 MB or smaller.";
    return "";
  }

  function setSingleFileSafe(next?: File) {
    const error = validateFile(next);
    if (error) { setSingleMessage(error); return; }
    if (singlePreview) URL.revokeObjectURL(singlePreview);
    setSingleFile(next!);
    setSinglePreview(URL.createObjectURL(next!));
    setSingleResult("");
    setSingleResultPreview("");
    setSingleMessage("");
    setSingleProgress({ percent: 0, label: "", state: "idle" });
  }

  function setReferenceFile(kind: "main" | "reference", next?: File) {
    const error = validateFile(next);
    if (error) { setReferenceMessage(error); return; }
    if (kind === "main") {
      if (referenceMainPreview) URL.revokeObjectURL(referenceMainPreview);
      setReferenceMain(next!);
      setReferenceMainPreview(URL.createObjectURL(next!));
    } else {
      if (referencePreview) URL.revokeObjectURL(referencePreview);
      setReferenceImage(next!);
      setReferencePreview(URL.createObjectURL(next!));
    }
    setReferenceResult("");
    setReferenceResultPreview("");
    setReferenceMessage("");
    setReferenceProgress({ percent: 0, label: "", state: "idle" });
  }

  function addBatchFiles(list: FileList | File[]) {
    const all = Array.from(list);
    const incoming = all.filter((file) => ["image/png", "image/jpeg", "image/webp"].includes(file.type) && file.size <= MAX_FILE_BYTES);
    const remaining = MAX_BATCH - batchItemsRef.current.length;
    if (remaining <= 0) { setBatchMessage(`Maximum ${MAX_BATCH} images per batch.`); return; }
    const accepted = incoming.slice(0, remaining).map((file) => ({
      id: crypto.randomUUID(), file, preview: URL.createObjectURL(file), progress: 0, label: "Ready", status: "ready" as BatchStatus,
    }));
    setBatchItems((current) => {
      const next = [...current, ...accepted];
      batchItemsRef.current = next;
      return next;
    });
    if (incoming.length > remaining) setBatchMessage(`Only the first ${remaining} image${remaining === 1 ? "" : "s"} were added. Maximum is ${MAX_BATCH}.`);
    else if (accepted.length !== all.length) setBatchMessage("Some files were skipped. Use PNG, JPG, or WEBP up to 12 MB each.");
    else setBatchMessage("");
  }

  function removeBatchItem(id: string) {
    setBatchItems((current) => {
      const item = current.find((entry) => entry.id === id);
      if (item) URL.revokeObjectURL(item.preview);
      const next = current.filter((entry) => entry.id !== id);
      batchItemsRef.current = next;
      return next;
    });
  }

  function clearBatch() {
    batchItems.forEach((item) => URL.revokeObjectURL(item.preview));
    batchItemsRef.current = [];
    setBatchItems([]);
    setBatchMessage("");
  }

  function updateBatchItem(id: string, patch: Partial<BatchItem>) {
    setBatchItems((current) => {
      const next = current.map((item) => item.id === id ? { ...item, ...patch } : item);
      batchItemsRef.current = next;
      return next;
    });
  }

  function startBatchUpload(item: BatchItem) {
    const current = batchItemsRef.current.find((entry) => entry.id === item.id) || item;
    if (current.uploadedUrl) return Promise.resolve(current.uploadedUrl);
    if (!current.file) return Promise.reject(new Error("The original image is no longer available. Remove it and add it again."));
    const existing = batchUploadPromisesRef.current.get(item.id);
    if (existing) return existing;

    updateBatchItem(item.id, { error: undefined, progress: Math.max(1, current.progress), label: "Queued for upload…", status: "uploading" });
    const promise = new Promise<string>((resolve, reject) => {
      batchUploadQueueRef.current.push(() => {
        if (batchStopRequestedRef.current) {
          batchUploadPromisesRef.current.delete(item.id);
          reject(new Error("Batch stopped."));
          return;
        }
        activeBatchUploadsRef.current += 1;
        updateBatchItem(item.id, { label: "Uploading…", status: "uploading" });
        void uploadImage(current.file!, (percentage) => {
          const now = Date.now();
          const rounded = Math.round(percentage);
          const previous = batchUploadProgressRef.current.get(item.id);
          if (rounded < 100 && previous && rounded - previous.percent < 5 && now - previous.at < 300) return;
          batchUploadProgressRef.current.set(item.id, { percent: rounded, at: now });
          updateBatchItem(item.id, {
            progress: Math.max(1, percentage * 0.45),
            label: `Uploading · ${rounded}%`,
            status: "uploading",
          });
        }).then((uploadedUrl) => {
          updateBatchItem(item.id, { uploadedUrl, progress: 48, label: "Uploaded · ready to generate", status: "queued", error: undefined });
          resolve(uploadedUrl);
        }).catch((error) => {
          const detail = error instanceof Error ? error.message : "Upload failed";
          updateBatchItem(item.id, { progress: 100, label: detail, status: "failed", error: detail });
          reject(error);
        }).finally(() => {
          activeBatchUploadsRef.current -= 1;
          batchUploadPromisesRef.current.delete(item.id);
          batchUploadProgressRef.current.delete(item.id);
          pumpBatchUploads();
        });
      });
    });
    batchUploadPromisesRef.current.set(item.id, promise);
    pumpBatchUploads();
    return promise;
  }

  function pumpBatchUploads() {
    // Keep uploads bounded, but allow two source transfers so AI task submission is not starved.
    while (activeBatchUploadsRef.current < BATCH_UPLOAD_CONCURRENCY && batchUploadQueueRef.current.length) {
      batchUploadQueueRef.current.shift()?.();
    }
  }

  function releaseBatchLocalSource(id: string, uploadedUrl: string) {
    const current = batchItemsRef.current.find((item) => item.id === id);
    if (current?.preview?.startsWith("blob:")) URL.revokeObjectURL(current.preview);
    updateBatchItem(id, { file: undefined, preview: uploadedUrl });
  }

  async function pollTask(taskId: string, onStatus: (status: string) => void) {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
      const statusResponse = await fetch(`/api/task?id=${encodeURIComponent(taskId)}`, { cache: "no-store" });
      const status = await statusResponse.json() as {
        status?: string;
        output?: string[];
        previewUrl?: string;
        downloadUrl?: string;
        error?: string;
      };
      if (!statusResponse.ok) throw new Error(status.error || "Could not check generation.");
      if (status.status === "succeeded" && status.output?.[0]) {
        return {
          url: status.downloadUrl || status.output[0],
          previewUrl: status.previewUrl || status.output[0],
        };
      }
      if (status.status === "failed") throw new Error(status.error || "Generation failed");
      onStatus(status.status || "processing");
    }
    throw new Error("Generation took too long. Please try again.");
  }

  function taskPercent(status: string) {
    if (/queue|pending|start|prepar/i.test(status)) return 60;
    return 72;
  }

  function confirmGenerationStop(label: string) {
    const first = window.confirm(`Stop ${label}? Work that has not reached V-Editor will be cancelled.`);
    if (!first) return false;
    return window.confirm(
      `Confirm stop again. If V-Editor already accepted the current task, Pixora will let that task finish so the generation credit/result is not wasted.`
    );
  }

  function requestSingleStop() {
    if (!singleBusy || singleStopRequestedRef.current || !confirmGenerationStop("this edit")) return;
    singleStopRequestedRef.current = true;
    setSingleStopRequested(true);
    if (singleStageRef.current === "uploading") {
      singleUploadAbortRef.current?.abort();
      setSingleMessage("Stopping upload…");
    } else {
      setSingleMessage("Stop requested. An already-submitted V-Editor task will finish safely.");
    }
  }

  function requestReferenceStop() {
    if (!referenceBusy || referenceStopRequestedRef.current || !confirmGenerationStop("this reference edit")) return;
    referenceStopRequestedRef.current = true;
    setReferenceStopRequested(true);
    if (referenceStageRef.current === "uploading") {
      referenceUploadAbortRef.current?.abort();
      setReferenceMessage("Stopping uploads…");
    } else {
      setReferenceMessage("Stop requested. An already-submitted V-Editor task will finish safely.");
    }
  }

  async function generateSingle() {
    if (!validImage(singleFile) || !singlePrompt.trim()) { setSingleMessage("Choose an image and enter a prompt."); return; }

    singleStopRequestedRef.current = false;
    setSingleStopRequested(false);
    setSingleBusy(true);
    setSingleMessage("");
    setOutputTab("result");
    setSingleProgress({ percent: 1, label: "Starting upload…", state: "working" });

    const uploadController = new AbortController();
    singleUploadAbortRef.current = uploadController;

    try {
      singleStageRef.current = "uploading";
      const imageUrl = await uploadImage(
        singleFile!,
        (percentage) => setSingleProgress({ percent: Math.max(1, percentage * 0.45), label: `Uploading image · ${Math.round(percentage)}%`, state: "working" }),
        uploadController.signal,
      );

      if (singleStopRequestedRef.current) {
        setSingleProgress({ percent: 100, label: "Stopped before AI generation", state: "stopped" });
        setSingleMessage("Stopped before V-Editor generation started.");
        return;
      }

      singleStageRef.current = "submitting";
      setSingleProgress({ percent: 50, label: "Creating V-Editor task…", state: "working" });
      const prompt = applyPreservation(singlePrompt, preserveFace, preservePose);
      const create = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl, prompt, aspectRatio: singleRatio }),
      });
      const created = await create.json() as { taskId?: string; error?: string };
      if (!create.ok || !created.taskId) throw new Error(created.error || "Could not start generation");

      singleStageRef.current = "processing";
      setSingleProgress({ percent: 60, label: singleStopRequestedRef.current ? "Stop requested · finishing accepted task…" : "Task accepted by V-Editor…", state: "working" });
      const output = await pollTask(created.taskId, (status) => setSingleProgress({
        percent: taskPercent(status),
        label: singleStopRequestedRef.current ? "Stop requested · finishing accepted task…" : `V-Editor ${status.replace(/_/g, " ")}…`,
        state: "working",
      }));

      setSingleResult(output.url);
      setSingleResultPreview(output.previewUrl);
      addHistory(output.url, singlePrompt.trim(), true, output.previewUrl);
      setSingleProgress({ percent: 100, label: "Completed", state: "done" });
      if (singleStopRequestedRef.current) setSingleMessage("The task was already accepted by V-Editor, so Pixora finished it safely and stopped.");
    } catch (error) {
      if (singleStopRequestedRef.current && singleStageRef.current === "uploading") {
        setSingleProgress({ percent: 100, label: "Stopped", state: "stopped" });
        setSingleMessage("Generation stopped before V-Editor received the image.");
      } else {
        const detail = error instanceof Error ? error.message : "Something went wrong";
        setSingleMessage(detail);
        setSingleProgress((current) => ({ ...current, label: detail, state: "error" }));
      }
    } finally {
      singleStageRef.current = "idle";
      singleUploadAbortRef.current = null;
      setSingleBusy(false);
    }
  }

  async function generateReference() {
    if (!validImage(referenceMain) || !validImage(referenceImage) || !referencePrompt.trim()) {
      setReferenceMessage("Choose both images and enter a prompt.");
      return;
    }

    referenceStopRequestedRef.current = false;
    setReferenceStopRequested(false);
    setReferenceBusy(true);
    setReferenceMessage("");
    setOutputTab("result");

    const uploadController = new AbortController();
    referenceUploadAbortRef.current = uploadController;
    let mainUpload = 0;
    let refUpload = 0;
    const syncProgress = () => setReferenceProgress({
      percent: Math.max(1, ((mainUpload + refUpload) / 2) * 0.45),
      label: `Uploading both images · ${Math.round((mainUpload + refUpload) / 2)}%`,
      state: "working",
    });
    setReferenceProgress({ percent: 1, label: "Starting uploads…", state: "working" });

    try {
      referenceStageRef.current = "uploading";
      const [imageUrl, referenceImageUrl] = await Promise.all([
        uploadImage(referenceMain!, (percentage) => { mainUpload = percentage; syncProgress(); }, uploadController.signal),
        uploadImage(referenceImage!, (percentage) => { refUpload = percentage; syncProgress(); }, uploadController.signal),
      ]);

      if (referenceStopRequestedRef.current) {
        setReferenceProgress({ percent: 100, label: "Stopped before AI generation", state: "stopped" });
        setReferenceMessage("Stopped before V-Editor generation started.");
        return;
      }

      referenceStageRef.current = "submitting";
      setReferenceProgress({ percent: 50, label: "Creating reference edit task…", state: "working" });
      const prompt = applyPreservation(referencePrompt, preserveFace, preservePose, true);
      const create = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl, referenceImageUrl, prompt, aspectRatio: referenceRatio }),
      });
      const created = await create.json() as { taskId?: string; error?: string };
      if (!create.ok || !created.taskId) throw new Error(created.error || "Could not start generation");

      referenceStageRef.current = "processing";
      setReferenceProgress({ percent: 60, label: referenceStopRequestedRef.current ? "Stop requested · finishing accepted task…" : "Reference task accepted…", state: "working" });
      const output = await pollTask(created.taskId, (status) => setReferenceProgress({
        percent: taskPercent(status),
        label: referenceStopRequestedRef.current ? "Stop requested · finishing accepted task…" : `V-Editor ${status.replace(/_/g, " ")}…`,
        state: "working",
      }));

      setReferenceResult(output.url);
      setReferenceResultPreview(output.previewUrl);
      addHistory(output.url, referencePrompt.trim(), true, output.previewUrl);
      setReferenceProgress({ percent: 100, label: "Completed", state: "done" });
      if (referenceStopRequestedRef.current) setReferenceMessage("The task was already accepted by V-Editor, so Pixora finished it safely and stopped.");
    } catch (error) {
      if (referenceStopRequestedRef.current && referenceStageRef.current === "uploading") {
        setReferenceProgress({ percent: 100, label: "Stopped", state: "stopped" });
        setReferenceMessage("Reference generation stopped before V-Editor received the images.");
      } else {
        const detail = error instanceof Error ? error.message : "Something went wrong";
        setReferenceMessage(detail);
        setReferenceProgress((current) => ({ ...current, label: detail, state: "error" }));
      }
    } finally {
      referenceStageRef.current = "idle";
      referenceUploadAbortRef.current = null;
      setReferenceBusy(false);
    }
  }

  function requestBatchStop() {
    if (!batchBusy || batchStopRequestedRef.current) return;

    const firstConfirmed = window.confirm(
      "Stop this batch? Pixora will not start any more images after the current step."
    );
    if (!firstConfirmed) return;

    const secondConfirmed = window.confirm(
      "Confirm stop again. Any V-Editor task already accepted will be allowed to finish so its result and credit are not wasted. Remaining images will not be generated."
    );
    if (!secondConfirmed) return;

    batchStopRequestedRef.current = true;
    setBatchStopRequested(true);
    setBatchMessage("Stop requested. Finishing any already-started V-Editor task, then the batch will stop.");
  }

  async function generateBatch() {
    if (!batchItems.length || !batchPrompt.trim()) { setBatchMessage("Add at least one image and enter a shared prompt."); return; }
    if (batchItems.length > MAX_BATCH) { setBatchMessage(`Maximum ${MAX_BATCH} images per batch.`); return; }

    batchStopRequestedRef.current = false;
    setBatchStopRequested(false);
    setBatchBusy(true);
    setBatchMessage("");
    setOutputTab("result");

    const itemIds = batchItemsRef.current.map((item) => item.id);
    const prompt = applyPreservation(batchPrompt, preserveFace, preservePose);

    setBatchItems((current) => {
      const next = current.map((item) => ({
        ...item,
        taskId: undefined,
        result: undefined,
        resultPreview: undefined,
        error: undefined,
        progress: item.uploadedUrl ? 48 : 0,
        label: item.uploadedUrl ? "Uploaded · queued" : "Queued",
        status: item.uploadedUrl ? "queued" as BatchStatus : "ready" as BatchStatus,
      }));
      batchItemsRef.current = next;
      return next;
    });

    try {
      setBatchMessage("Preparing generation queue…");
      const planResponse = await fetch("/api/batch-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: itemIds.length }),
      });
      const plan = await planResponse.json() as { leases?: string[]; error?: string };
      const leases = Array.isArray(plan.leases) ? plan.leases : [];
      if (!planResponse.ok || leases.length !== itemIds.length) {
        throw new Error(plan.error || "Could not prepare enough V-Editor slots for this batch.");
      }
      setBatchMessage("");

      // Bounded streaming queue: token allocation is done once, uploads stay controlled,
      // and only a few images are active end-to-end at once. Accepted V-Editor jobs can
      // overlap, so the model is not idle while the browser still avoids a 50-image burst.
      await mapLimit(itemIds, BATCH_PIPELINE_CONCURRENCY, async (id, index) => {
        if (batchStopRequestedRef.current) return;

        const item = batchItemsRef.current.find((entry) => entry.id === id);
        if (!item) return;

        try {
          updateBatchItem(id, {
            progress: item.uploadedUrl ? 48 : Math.max(1, item.progress),
            label: item.uploadedUrl ? "Uploaded · creating task" : `Uploading image ${index + 1} of ${itemIds.length}…`,
            status: item.uploadedUrl ? "queued" : "uploading",
            error: undefined,
          });

          const uploadedUrl = item.uploadedUrl || await startBatchUpload(item);
          releaseBatchLocalSource(id, uploadedUrl);

          if (batchStopRequestedRef.current) {
            updateBatchItem(id, { uploadedUrl, progress: 48, label: "Stopped before AI generation", status: "stopped" });
            return;
          }

          updateBatchItem(id, { uploadedUrl, progress: 52, label: "Creating V-Editor task…", status: "queued" });

          const lease = leases[index];
          if (!lease) throw new Error("Missing generation allocation for this image.");

          const create = await fetch("/api/generate-item", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageUrl: uploadedUrl, prompt, aspectRatio: batchRatio, lease }),
          });
          const created = await create.json() as { taskId?: string; error?: string };

          if (!create.ok || !created.taskId) throw new Error(created.error || "Could not start this image.");

          updateBatchItem(id, { taskId: created.taskId, progress: 60, label: "V-Editor processing", status: "processing" });

          const output = await pollTask(created.taskId, (status) => updateBatchItem(id, {
            progress: taskPercent(status),
            label: status.replace(/_/g, " "),
            status: "processing",
          }));

          updateBatchItem(id, {
            result: output.url,
            resultPreview: output.previewUrl,
            progress: 100,
            label: "Completed",
            status: "done",
          });
          addHistory(output.url, batchPrompt.trim(), false, output.previewUrl);
        } catch (error) {
          if (batchStopRequestedRef.current) {
            const current = batchItemsRef.current.find((entry) => entry.id === id);
            if (current && current.status !== "done" && current.status !== "processing") {
              updateBatchItem(id, { label: "Stopped · not processed", status: "stopped" });
              return;
            }
          }
          const detail = error instanceof Error ? error.message : "Generation failed";
          updateBatchItem(id, { progress: 100, label: detail, status: "failed", error: detail });
        }
      });

      if (batchStopRequestedRef.current) {
        setBatchItems((current) => {
          const next = current.map((item) => {
            if (item.status === "done" || item.status === "failed" || item.status === "stopped") return item;
            return { ...item, status: "stopped" as BatchStatus, label: "Stopped · not processed" };
          });
          batchItemsRef.current = next;
          return next;
        });
        const completed = batchItemsRef.current.filter((item) => item.status === "done").length;
        setBatchMessage(`Batch stopped. ${completed} image${completed === 1 ? "" : "s"} completed; remaining images were not started.`);
      }

      try {
        const statsResponse = await fetch("/api/stats", { cache: "no-store" });
        const stats = await statsResponse.json() as { totalGenerated?: number };
        if (statsResponse.ok && typeof stats.totalGenerated === "number") setTotalGenerated(stats.totalGenerated);
      } catch {
        // Results are already complete; a stats refresh failure should not fail the batch.
      }
    } catch (error) {
      setBatchMessage(error instanceof Error ? error.message : "Batch generation failed");
    } finally {
      setBatchBusy(false);
    }
  }

  function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / Math.pow(1024, unitIndex);
    return `${value >= 100 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
  }

  function uniqueDownloadNumber() {
    const key = "pixora-download-sequence";
    let sequence = 0;
    try {
      sequence = (Number(localStorage.getItem(key) || "0") + 1) % 1_000_000;
      localStorage.setItem(key, String(sequence));
    } catch {
      sequence = Math.floor(Math.random() * 1_000_000);
    }
    const random = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
    return `${Date.now()}${String(sequence).padStart(6, "0")}${String(random).padStart(6, "0")}`;
  }

  function originalDownloadUrl(
    url: string,
    filename = "",
    disposition: "attachment" | "inline" = "attachment",
  ) {
    try {
      // Keep task-aware Pixora result links same-origin and SSR-safe.
      const parsed = new URL(url, "https://pixora.local");
      if (parsed.pathname === "/api/result") {
        if (filename) parsed.searchParams.set("filename", filename);
        parsed.searchParams.set("disposition", disposition);
        return `${parsed.pathname}?${parsed.searchParams.toString()}`;
      }
    } catch {}

    const params = new URLSearchParams({
      url: originalImageUrl(url),
      ...(filename ? { filename } : {}),
      disposition,
    });
    return `/api/download?${params.toString()}`;
  }

  async function prepareNativeDownload(url: string, filename: string) {
    // Downloads are now true pass-throughs. Do not prefetch, recompress, resize,
    // or buffer the generated file before handing it to the browser.
    return {
      url: originalDownloadUrl(url, filename, "attachment"),
      size: 0,
    };
  }

  function triggerPreparedDownload(downloadUrl: string, filename: string) {
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    window.setTimeout(() => anchor.remove(), 1000);
  }

  async function downloadOne(url: string, index = 1) {
    const filename = `Pixora-${uniqueDownloadNumber()}.png`;
    try {
      setDownloadProgress({
        percent: 5,
        label: "Starting original-quality download…",
        state: "working",
      });

      const prepared = await prepareNativeDownload(url, filename);
      setDownloadProgress({
        percent: 90,
        label: prepared.size > 0
          ? `Ready · ${formatBytes(prepared.size)} · starting browser download…`
          : "Ready · starting browser download…",
        state: "working",
      });

      triggerPreparedDownload(prepared.url, filename);
      setDownloadedUrls((current) => current.includes(url) ? current : [...current, url]);
      setDownloadNoticeUrl(previewForUrl(url));
      window.setTimeout(() => setDownloadNoticeUrl(""), 1600);

      setDownloadProgress({
        percent: 100,
        label: prepared.size > 0
          ? `Download started · ${formatBytes(prepared.size)}`
          : "Download started",
        state: "done",
      });
      window.setTimeout(() => setDownloadProgress({ percent: 0, label: "", state: "idle" }), 2600);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Download failed";
      setSingleMessage(detail);
      setDownloadProgress({ percent: 100, label: detail, state: "error" });
    }
  }

  async function downloadMany(urls: string[], kind: "zip" | "separate") {
    if (!urls.length) return;
    const batchId = uniqueDownloadNumber();
    const sourceUrls = urls.map((url) => originalDownloadUrl(url, "", "inline"));

    if (kind === "zip") {
      if (!supportsStreamingZip()) {
        throw new Error("Large ZIP streaming needs Chrome or Edge desktop. Use Separate files in this browser.");
      }

      const sources = sourceUrls.map((url, index) => ({
        url,
        filename: `Pixora-${batchId}-${String(index + 1).padStart(3, "0")}.png`,
      }));

      setDownloadProgress({
        percent: 1,
        label: "Choose where to save the ZIP…",
        state: "working",
      });

      // The native picker must run before any network await so the browser
      // still recognizes the user's click as active permission.
      await streamZipToDisk(
        sources,
        `Pixora-${batchId}.zip`,
        (progress) => {
          if (progress.phase === "preparing") {
            setDownloadProgress({
              percent: progress.percent,
              label: `Checking original files · ${progress.filesDone}/${progress.totalFiles}`,
              state: "working",
            });
            return;
          }

          const remaining = Math.max(0, progress.totalBytes - progress.loadedBytes);
          const sizeText = progress.totalBytes > 0
            ? `${formatBytes(progress.loadedBytes)} / ${formatBytes(progress.totalBytes)} · ${formatBytes(remaining)} remaining`
            : `${formatBytes(progress.loadedBytes)} written`;
          setDownloadProgress({
            percent: Math.max(8, progress.percent),
            label: `ZIP streaming to disk · ${sizeText} · ${progress.filesDone}/${progress.totalFiles} images`,
            state: "working",
          });
        },
      );

      setDownloadedUrls((current) => Array.from(new Set([...current, ...urls])));
      setDownloadProgress({ percent: 100, label: "ZIP saved to disk", state: "done" });
      return;
    }

    if (kind === "separate") {
      setDownloadProgress({
        percent: 5,
        label: `Sending ${urls.length} original-quality images to browser downloads…`,
        state: "working",
      });
      for (let index = 0; index < urls.length; index++) {
        const filename = `Pixora-${uniqueDownloadNumber()}.png`;
        setDownloadProgress({
          percent: 5 + ((index / Math.max(1, urls.length)) * 90),
          label: `Starting image ${index + 1} of ${urls.length}…`,
          state: "working",
        });
        const prepared = await prepareNativeDownload(urls[index], filename);
        triggerPreparedDownload(prepared.url, filename);
        setDownloadedUrls((current) => current.includes(urls[index]) ? current : [...current, urls[index]]);
        await new Promise((resolve) => window.setTimeout(resolve, 180));
      }
      setDownloadProgress({
        percent: 100,
        label: `${urls.length} original downloads started`,
        state: "done",
      });
      return;
    }


  }

  async function downloadSelected(kind: "zip" | "separate") {
    if (!selected.length) return;
    setDownloading(true);
    setDownloadMenu(false);
    setSingleMessage("");
    try {
      await downloadMany(selected, kind);
    } catch (error) {
      setSingleMessage(error instanceof Error ? error.message : "Download failed");
    } finally {
      setDownloading(false);
      window.setTimeout(() => setDownloadProgress({ percent: 0, label: "", state: "idle" }), 3200);
    }
  }

  async function downloadBatch(kind: "zip" | "separate") {
    setBatchDownloading(true);
    setBatchMessage("");
    try {
      await downloadMany(batchResults, kind);
    } catch (error) {
      setBatchMessage(error instanceof Error ? error.message : "Download failed");
    } finally {
      setBatchDownloading(false);
      window.setTimeout(() => setDownloadProgress({ percent: 0, label: "", state: "idle" }), 3200);
    }
  }

  function clearHistory() {
    if (isProcessing) return;
    const hidden = readHiddenHistory();
    localStorage.setItem("pixora-history-hidden", JSON.stringify(Array.from(new Set([...hidden, ...history.map((item) => item.url)]))));
    dismissUndo();
    localStorage.removeItem("pixora-history");
    setHistory([]);
    setSelected([]);
    setSelecting(false);
    setDownloadMenu(false);
    setOutputTab("history");
    if (accountEmail) void fetch("/api/account-history", { method: "DELETE" });
  }

  function readHiddenHistory() {
    try { return JSON.parse(localStorage.getItem("pixora-history-hidden") || "[]") as string[]; } catch { return []; }
  }

  function dismissUndo() {
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    undoTimerRef.current = null;
    setPendingUndo(null);
  }

  function removeHistoryItem(item: HistoryItem, index: number) {
    if (isProcessing) return;
    dismissUndo();
    setHistory((current) => {
      const next = current.filter((entry) => entry.url !== item.url);
      localStorage.setItem("pixora-history", JSON.stringify(next));
      return next;
    });
    localStorage.setItem("pixora-history-hidden", JSON.stringify(Array.from(new Set([...readHiddenHistory(), item.url]))));
    if (accountEmail) {
      const deletion = fetch(`/api/account-history?url=${encodeURIComponent(item.url)}`, { method: "DELETE" })
        .catch(() => undefined)
        .finally(() => historyDeletePromisesRef.current.delete(item.url));
      historyDeletePromisesRef.current.set(item.url, deletion);
    }
    setSelected((current) => current.filter((url) => url !== item.url));
    setPendingUndo({ item, index });
    undoTimerRef.current = window.setTimeout(() => {
      setPendingUndo(null);
      undoTimerRef.current = null;
    }, 5000);
  }

  async function undoHistoryRemoval() {
    if (!pendingUndo) return;
    const { item, index } = pendingUndo;
    localStorage.setItem("pixora-history-hidden", JSON.stringify(readHiddenHistory().filter((url) => url !== item.url)));

    const pendingDelete = historyDeletePromisesRef.current.get(item.url);
    if (pendingDelete) await pendingDelete;
    if (accountEmail) await saveSyncedHistoryItem(item).catch(() => false);

    setHistory((current) => {
      const withoutItem = current.filter((entry) => entry.url !== item.url);
      const next = [...withoutItem];
      next.splice(Math.min(index, next.length), 0, item);
      localStorage.setItem("pixora-history", JSON.stringify(next));
      return next;
    });
    dismissUndo();
  }

  function toggleSelection(url: string) {
    setSelected((current) => current.includes(url) ? current.filter((item) => item !== url) : [...current, url]);
  }

  function singleDrop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); if (!isProcessing) setSingleFileSafe(event.dataTransfer.files[0]); }
  function batchDrop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); if (!isProcessing) addBatchFiles(event.dataTransfer.files); }
  function referenceDrop(kind: "main" | "reference", event: DragEvent<HTMLDivElement>) { event.preventDefault(); if (!isProcessing) setReferenceFile(kind, event.dataTransfer.files[0]); }

  function openViewer(urls: string[], index: number, previews?: string[]) {
    setViewerUrls(urls);
    setViewerPreviewUrls(previews?.length === urls.length ? previews : urls);
    setViewerIndex(index);
  }

  function moveViewer(direction: -1 | 1) {
    setViewerIndex((current) => (current + direction + viewerUrls.length) % viewerUrls.length);
  }

  useEffect(() => {
    if (!viewerUrls.length) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setViewerUrls([]);
      if (event.key === "ArrowLeft") setViewerIndex((current) => (current - 1 + viewerUrls.length) % viewerUrls.length);
      if (event.key === "ArrowRight") setViewerIndex((current) => (current + 1) % viewerUrls.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewerUrls.length]);

  const activeResult = mode === "single" ? singleResult : mode === "reference" ? referenceResult : "";
  const activeResultPreview = mode === "single" ? singleResultPreview : mode === "reference" ? referenceResultPreview : "";
  const batchPreviewResults = batchItems.filter((item) => item.result).map((item) => item.resultPreview || item.result!);

  function previewForUrl(url: string) {
    const historyItem = history.find((item) => item.url === url);
    if (historyItem?.previewUrl) return historyItem.previewUrl;
    const batchItem = batchItems.find((item) => item.result === url);
    if (batchItem?.resultPreview) return batchItem.resultPreview;
    if (url === singleResult && singleResultPreview) return singleResultPreview;
    if (url === referenceResult && referenceResultPreview) return referenceResultPreview;
    return url;
  }

  return <main className="shell">
    <nav className="nav"><a className="brand" href="#top" aria-label="Pixora home"><span className="brandMark">P</span><span>Pixora</span><small className="versionBadge">v{APP_VERSION}</small></a><div className="navActions"><span className="statusDot"><i /> V-Editor connected</span><a href="#how">How it works</a>{accountEmail ? <div className="accountChip"><span>{accountEmail}</span><button type="button" disabled={isProcessing} onClick={() => void signOutAccount()}>Sign out</button></div> : <button type="button" className="accountLoginButton" onClick={() => { setAuthMessage(""); setAuthOpen(true); }}>Sign in</button>}</div></nav>
    {versionNotice && <div className="versionNotice" role="status"><b>✓ Updated to v{APP_VERSION}</b><span>The latest Pixora fixes are active.</span><button type="button" onClick={() => setVersionNotice(false)} aria-label="Close update notice">×</button></div>}

    <section className="hero" id="top"><div className="eyebrow"><span>✦</span> AI PHOTO EDITOR</div><h1>Edit any photo.<br /><em>Just describe it.</em></h1><p>Single edits, batch transformations, and reference-guided creations—powered by V-Editor.</p><div className="heroBadges"><div className="unlimited"><span>∞</span><div><strong>Unlimited trials</strong><small>Explore freely during early access</small></div></div><div className="generatedCount"><strong>{totalGenerated === null ? "—" : totalGenerated.toLocaleString()}</strong><span>images generated</span></div></div></section>

    <section className={`studio studioMulti ${isProcessing ? "processing" : ""}`} aria-label="AI photo editor">
      <div className="modeTabs" role="tablist" aria-label="Editing modes">
        <button type="button" disabled={isProcessing} className={mode === "single" ? "active" : ""} onClick={() => { setMode("single"); setOutputTab("result"); }}><b>Single</b><small>1 image + prompt</small></button>
        <button type="button" disabled={isProcessing} className={mode === "batch" ? "active" : ""} onClick={() => { setMode("batch"); setOutputTab("result"); }}><b>Batch</b><small>Up to {MAX_BATCH} images</small></button>
        <button type="button" disabled={isProcessing} className={mode === "reference" ? "active" : ""} onClick={() => { setMode("reference"); setOutputTab("result"); }}><b>Reference</b><small>Main + reference</small></button>
      </div>

      {mode === "single" && <>
        <div className="studioTop"><div><span className="step">01</span><h2>Single image edit</h2></div><span className="privacy">◆ Private by design</span></div>
        <div className="workspace">
          <div className={`dropzone ${singlePreview ? "hasImage" : ""} ${isProcessing ? "locked" : ""}`} onClick={() => !isProcessing && singleInputRef.current?.click()} onDrop={singleDrop} onDragOver={(e) => e.preventDefault()} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && !isProcessing && singleInputRef.current?.click()}>
            <input ref={singleInputRef} disabled={isProcessing} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => setSingleFileSafe(e.target.files?.[0])} />
            {singlePreview ? <><img src={singlePreview} alt="Selected preview" />{!isProcessing && <button type="button" className="replace" onClick={(e) => { e.stopPropagation(); singleInputRef.current?.click(); }}>Replace image</button>}</> : <UploadEmpty title="Drop an image here" subtitle="or click to browse · PNG, JPG or WEBP · max 12 MB" />}
          </div>
          <div className="controls"><div className="controlHeading"><span className="step">02</span><h2>Describe your edit</h2></div><label className="promptLabel" htmlFor="single-prompt">YOUR PROMPT</label><textarea id="single-prompt" value={singlePrompt} onChange={(e) => setSinglePrompt(e.target.value)} placeholder="Make the scene look like golden hour, keep the person unchanged…" maxLength={700} /><div className="promptMeta"><button type="button" onClick={() => setSinglePrompt("Replace the background with a warm, cinematic sunset while keeping the subject unchanged.")}>✦ Try an example</button><span>{singlePrompt.length}/700</span></div><RatioPicker value={singleRatio} onChange={setSingleRatio} /><PreserveControls preserveFace={preserveFace} preservePose={preservePose} onFace={setPreserveFace} onPose={setPreservePose} /><ProgressBar progress={singleProgress} /><div className="runActions"><button type="button" className="generate" disabled={!singleFile || !singlePrompt.trim() || singleBusy} onClick={generateSingle}>{singleBusy ? <><span className="spinner" /> Working…</> : <>Generate edit <span>→</span></>}</button>{singleBusy && <button type="button" className="stopAction" disabled={singleStopRequested} onClick={requestSingleStop}>{singleStopRequested ? "Stopping…" : "■ Stop"}</button>}</div>{singleMessage && <p className="error">{singleMessage}</p>}<p className="fineprint">Same Face and Same Pose are prompt-level preservation locks; exact model output can still vary.</p></div>
        </div>
      </>}

      {mode === "batch" && <>
        <div className="studioTop"><div><span className="step">01</span><h2>Batch edit · {batchItems.length}/{MAX_BATCH}</h2></div><span className="privacy">◆ One prompt, separate generations</span></div>
        <div className="workspace batchWorkspace">
          <div className="batchPane">
            <div className="batchToolbar"><strong>Selected images</strong><div>{batchItems.length > 0 && <button type="button" onClick={clearBatch} disabled={isProcessing}>Clear all</button>}<button type="button" onClick={() => batchInputRef.current?.click()} disabled={isProcessing || batchItems.length >= MAX_BATCH}>+ Add images</button></div></div>
            <input ref={batchInputRef} disabled={isProcessing} type="file" multiple accept="image/png,image/jpeg,image/webp" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { if (e.target.files) addBatchFiles(e.target.files); e.target.value = ""; }} />
            {batchItems.length === 0 ? <div className="dropzone batchDropzone" onClick={() => batchInputRef.current?.click()} onDrop={batchDrop} onDragOver={(e) => e.preventDefault()} role="button" tabIndex={0}><UploadEmpty title={`Drop up to ${MAX_BATCH} images`} subtitle="One shared prompt will be applied to every image" button="Choose images" /></div> : <div className="batchGrid" onDrop={batchDrop} onDragOver={(e) => e.preventDefault()}>{batchItems.map((item, index) => <article key={item.id} className={`batchCard ${item.status}`}><div className="batchThumb"><img src={displayImageUrl(item.resultPreview || item.result || item.preview, 520, 86)} alt={item.result ? `Generated result ${index + 1}` : `Batch source ${index + 1}`} loading="lazy" decoding="async" />{!batchBusy && <button type="button" onClick={() => removeBatchItem(item.id)} aria-label={`Remove image ${index + 1}`}>×</button>}</div><div className="batchCardMeta"><span>{index + 1}</span><div><strong>{item.status === "done" ? "Done" : item.status === "failed" ? "Failed" : item.status === "stopped" ? "Stopped" : item.label}</strong><div className="miniProgress"><i style={{ width: `${item.progress}%` }} /></div></div><b>{Math.round(item.progress)}%</b></div>{item.result && <div className="batchResultActions"><button type="button" onClick={() => downloadOne(item.result!, index + 1)}>↓ Download</button><a href={originalDownloadUrl(item.result!, "", "inline")} target="_blank" rel="noopener noreferrer">Open ↗</a></div>}</article>)}</div>}
          </div>
          <div className="controls"><div className="controlHeading"><span className="step">02</span><h2>Shared batch prompt</h2></div><label className="promptLabel" htmlFor="batch-prompt">PROMPT FOR ALL IMAGES</label><textarea id="batch-prompt" value={batchPrompt} onChange={(e) => setBatchPrompt(e.target.value)} placeholder="Apply the same edit to every selected image…" maxLength={700} /><div className="promptMeta"><button type="button" onClick={() => setBatchPrompt("Give every image a clean cinematic color grade while preserving the subject and composition.")}>✦ Try an example</button><span>{batchPrompt.length}/700</span></div><RatioPicker value={batchRatio} onChange={setBatchRatio} /><PreserveControls preserveFace={preserveFace} preservePose={preservePose} onFace={setPreserveFace} onPose={setPreservePose} /><ProgressBar progress={batchProgress} /><div className="runActions"><button type="button" className="generate" disabled={!batchItems.length || !batchPrompt.trim() || batchBusy} onClick={generateBatch}>{batchBusy ? <><span className="spinner" /> Processing {batchDone}/{batchItems.length}</> : <>Generate {batchItems.length || ""} image{batchItems.length === 1 ? "" : "s"} <span>→</span></>}</button>{batchBusy && <button type="button" className="stopAction" disabled={batchStopRequested} onClick={requestBatchStop}>{batchStopRequested ? "Stopping…" : "■ Stop"}</button>}</div>{batchMessage && <p className="error">{batchMessage}</p>}<p className="fineprint">Memory-safe queue: uploads are controlled and only a few V-Editor jobs run at once for faster batch completion.</p></div>
        </div>
      </>}

      {mode === "reference" && <>
        <div className="studioTop"><div><span className="step">01</span><h2>Reference-guided edit</h2></div><span className="privacy">◆ Main image + reference</span></div>
        <div className="workspace referenceWorkspace">
          <div className="referenceUploads">
            <div><span className="uploadCaption">MAIN IMAGE</span><div className={`dropzone referenceDropzone ${referenceMainPreview ? "hasImage" : ""}`} onClick={() => referenceMainRef.current?.click()} onDrop={(e) => referenceDrop("main", e)} onDragOver={(e) => e.preventDefault()} role="button" tabIndex={0}><input ref={referenceMainRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => setReferenceFile("main", e.target.files?.[0])} />{referenceMainPreview ? <><img src={referenceMainPreview} alt="Main input" /><button type="button" className="replace" onClick={(e) => { e.stopPropagation(); referenceMainRef.current?.click(); }}>Replace</button></> : <UploadEmpty title="Main image" subtitle="The image you want to edit" />}</div></div>
            <div><span className="uploadCaption">REFERENCE IMAGE</span><div className={`dropzone referenceDropzone ${referencePreview ? "hasImage" : ""}`} onClick={() => referenceStyleRef.current?.click()} onDrop={(e) => referenceDrop("reference", e)} onDragOver={(e) => e.preventDefault()} role="button" tabIndex={0}><input ref={referenceStyleRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => setReferenceFile("reference", e.target.files?.[0])} />{referencePreview ? <><img src={referencePreview} alt="Reference input" /><button type="button" className="replace" onClick={(e) => { e.stopPropagation(); referenceStyleRef.current?.click(); }}>Replace</button></> : <UploadEmpty title="Reference image" subtitle="Style, pose, look, or visual guide" />}</div></div>
          </div>
          <div className="controls"><div className="controlHeading"><span className="step">02</span><h2>Tell V-Editor what to borrow</h2></div><label className="promptLabel" htmlFor="reference-prompt">YOUR PROMPT</label><textarea id="reference-prompt" value={referencePrompt} onChange={(e) => setReferencePrompt(e.target.value)} placeholder="Use the reference image's lighting and color style while keeping the person from the main image…" maxLength={700} /><div className="promptMeta"><button type="button" onClick={() => setReferencePrompt("Use the reference image's visual style and lighting while preserving the main subject's identity and composition.")}>✦ Try an example</button><span>{referencePrompt.length}/700</span></div><RatioPicker value={referenceRatio} onChange={setReferenceRatio} /><PreserveControls preserveFace={preserveFace} preservePose={preservePose} onFace={setPreserveFace} onPose={setPreservePose} /><ProgressBar progress={referenceProgress} /><div className="runActions"><button type="button" className="generate" disabled={!referenceMain || !referenceImage || !referencePrompt.trim() || referenceBusy} onClick={generateReference}>{referenceBusy ? <><span className="spinner" /> Working…</> : <>Generate reference edit <span>→</span></>}</button>{referenceBusy && <button type="button" className="stopAction" disabled={referenceStopRequested} onClick={requestReferenceStop}>{referenceStopRequested ? "Stopping…" : "■ Stop"}</button>}</div>{referenceMessage && <p className="error">{referenceMessage}</p>}<p className="fineprint">With a lock enabled, the main image stays authoritative for identity/pose; reference remains guidance.</p></div>
        </div>
      </>}

      <div className="output">
        <div className="tabs"><div><button type="button" className={outputTab === "result" ? "active" : ""} onClick={() => setOutputTab("result")}>Result</button><button type="button" className={outputTab === "history" ? "active" : ""} onClick={() => setOutputTab("history")}>1h History <span>{history.length}</span></button></div>{history.length > 0 && <button type="button" className="clearHistory" disabled={isProcessing} onClick={clearHistory}>Clear history</button>}</div>
        <ProgressBar progress={downloadProgress} />
        {outputTab === "history" && history.length > 0 && <div className="downloadBar"><div><button type="button" className={`selectToggle ${selecting ? "active" : ""}`} onClick={() => { setSelecting(!selecting); setSelected([]); setDownloadMenu(false); }}>{selecting ? "Done" : "Select"}</button>{selecting && <button type="button" className="selectAll" onClick={() => setSelected(selected.length === history.length ? [] : history.map((item) => item.url))}>{selected.length === history.length ? "Clear all" : "Select all"}</button>}</div>{selecting && <div className="downloadWrap"><button type="button" className="downloadSelected" disabled={!selected.length || downloading} onClick={() => setDownloadMenu(!downloadMenu)}>{downloading ? "Preparing…" : `Download ${selected.length || ""}`} <span>⌄</span></button>{downloadMenu && <div className="downloadMenu"><button type="button" onClick={() => void downloadSelected("zip")}><b>ZIP archive</b><small>One file with all selected images</small></button><button type="button" onClick={() => void downloadSelected("separate")}><b>Separate files</b><small>Trigger each selected download separately</small></button></div>}</div>}</div>}

        {outputTab === "result" ? mode === "batch" ? <div className="batchOutput">
          {batchResults.length ? <>
            <div className="batchOutputHead"><div><strong>{batchResults.length} result{batchResults.length === 1 ? "" : "s"} ready</strong><small>{batchBusy ? `${batchDone}/${batchItems.length} completed · queue active` : batchStopped ? `${batchStopped} stopped` : batchFailed ? `${batchFailed} failed` : "Batch completed"}</small></div><div><button type="button" disabled={batchDownloading} onClick={() => void downloadBatch("zip")}>{batchDownloading ? "Preparing…" : "↓ Download ZIP"}</button><button type="button" disabled={batchDownloading} onClick={() => void downloadBatch("separate")}>Separate files</button></div></div>
            <div className="batchOutputGrid">{batchItems.filter((item) => item.result).map((item, index) => <article key={item.id}>
              <div className={`downloadVisual ${downloadedUrls.includes(item.result!) ? "downloaded" : ""}`} onClick={() => openViewer(batchResults, index, batchPreviewResults)} role="button" tabIndex={0}><img src={displayImageUrl(item.resultPreview || item.result!, 900, 88)} alt={`Batch result ${index + 1}`} loading="lazy" decoding="async" /><span className="downloadCheck">✓<small>Download started</small></span></div>
              <div><button type="button" onClick={() => void downloadOne(item.result!, index + 1)}>↓ Download</button><a href={originalDownloadUrl(item.result!, "", "inline")} target="_blank" rel="noopener noreferrer">Open full size ↗</a></div>
            </article>)}</div>
          </> : <div className="emptyResult"><span>✦</span><h3>Your batch results will appear here</h3><p>Add up to {MAX_BATCH} images, use one prompt, and generate them together.</p></div>}
        </div> : <div className="resultArea">
          {activeResult ? <div className="resultCard">
            <div className={`downloadVisual ${downloadedUrls.includes(activeResult) ? "downloaded" : ""}`} onClick={() => {
              const index = history.findIndex((item) => item.url === activeResult);
              openViewer(
                index >= 0 ? history.map((item) => item.url) : [activeResult],
                index >= 0 ? index : 0,
                index >= 0 ? history.map((item) => item.previewUrl || item.url) : [activeResultPreview || activeResult],
              );
            }} role="button" tabIndex={0}><img src={displayImageUrl(activeResultPreview || activeResult, 1200, 90)} alt="AI generated edit" decoding="async" /><span className="downloadCheck">✓<small>Download started</small></span></div>
            <div className="resultActions"><button type="button" onClick={() => void downloadOne(activeResult)}>↓ Download</button><a href={originalDownloadUrl(activeResult, "", "inline")} target="_blank" rel="noopener noreferrer">Open full size ↗</a></div>
          </div> : <div className="emptyResult"><span>✦</span><h3>Your creation will appear here</h3><p>{mode === "reference" ? "Add a main image, reference image, and prompt." : "Upload an image, write a prompt, and let Pixora do the rest."}</p></div>}
        </div> : <div className={`historyGrid ${selecting ? "selecting" : ""}`}>
          {history.length ? history.map((item, index) => <article key={item.createdAt} className={selected.includes(item.url) ? "selected" : ""} onClick={() => selecting ? toggleSelection(item.url) : openViewer(history.map((entry) => entry.url), index, history.map((entry) => entry.previewUrl || entry.url))} role="button" tabIndex={0} onKeyDown={(event) => event.key === "Enter" && (selecting ? toggleSelection(item.url) : openViewer(history.map((entry) => entry.url), index, history.map((entry) => entry.previewUrl || entry.url)))}>
            {selecting && <span className="check">{selected.includes(item.url) ? "✓" : ""}</span>}
            {!selecting && <button type="button" className="historyDelete" disabled={isProcessing} aria-label="Remove image from history" onClick={(event) => { event.stopPropagation(); removeHistoryItem(item, index); }}>×</button>}
            <div className={`downloadVisual ${downloadedUrls.includes(item.url) ? "downloaded" : ""}`}><img src={displayImageUrl(item.previewUrl || item.url, 720, 86)} alt={item.prompt} loading="lazy" decoding="async" /><span className="downloadCheck">✓<small>Download started</small></span></div>
            <div className="historyCaption"><span>{item.prompt}</span>{!selecting && <button type="button" aria-label="Download image" onClick={(event) => { event.stopPropagation(); void downloadOne(item.url, index + 1); }}>↓</button>}</div>
          </article>) : <div className="emptyResult"><h3>No edits yet</h3><p>Edits are kept for 1 hour. Sign in to sync them across devices.</p></div>}
        </div>}
      </div>
    </section>

    {authOpen && <div className="accountOverlay" role="dialog" aria-modal="true" aria-label="Pixora account" onClick={() => !authBusy && setAuthOpen(false)}>
      <form className="accountCard" onSubmit={(event) => { event.preventDefault(); void submitAccount(); }} onClick={(event) => event.stopPropagation()}>
        <button type="button" className="accountClose" disabled={authBusy} onClick={() => setAuthOpen(false)} aria-label="Close">×</button>
        <span className="accountEyebrow">PIXORA ACCOUNT</span>
        <h3>Sign in or create account</h3>
        <p>Enter an email and password. If the email does not exist yet, Pixora creates the account instantly. No email verification.</p>
        <label>Email</label>
        <input type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" required />
        <label>Password</label>
        <input type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} placeholder="Minimum 6 characters" autoComplete="current-password" minLength={6} required />
        <button type="submit" className="accountSubmit" disabled={authBusy || !authEmail.trim() || authPassword.length < 6}>{authBusy ? "Signing in…" : "Continue"}</button>
        <small>Your generated history is synced across devices for 1 hour.</small>
        {authMessage && <div className="accountMessage">{authMessage}</div>}
      </form>
    </div>}

    {viewerUrls.length > 0 && <div className="imageViewer" role="dialog" aria-modal="true" aria-label="Image preview" onClick={() => setViewerUrls([])}>
      <button type="button" className="viewerClose" onClick={() => setViewerUrls([])} aria-label="Close preview">×</button>
      {viewerUrls.length > 1 && <button type="button" className="viewerPrevious" onClick={(event) => { event.stopPropagation(); moveViewer(-1); }} aria-label="Previous image">‹</button>}
      <div className="viewerCanvas" onClick={(event) => event.stopPropagation()} onTouchStart={(event) => { swipeStart.current = event.touches[0].clientX; }} onTouchEnd={(event) => {
        if (swipeStart.current === null) return;
        const distance = event.changedTouches[0].clientX - swipeStart.current;
        if (Math.abs(distance) > 45 && viewerUrls.length > 1) moveViewer(distance > 0 ? -1 : 1);
        swipeStart.current = null;
      }}>
        <img src={viewerPreviewUrls[viewerIndex] || viewerUrls[viewerIndex]} alt={`Preview ${viewerIndex + 1} of ${viewerUrls.length}`} />
        <span>{viewerIndex + 1} / {viewerUrls.length}</span>
      </div>
      {viewerUrls.length > 1 && <button type="button" className="viewerNext" onClick={(event) => { event.stopPropagation(); moveViewer(1); }} aria-label="Next image">›</button>}
    </div>}

    {downloadNoticeUrl && <div className="downloadNotice" role="status"><img src={displayImageUrl(downloadNoticeUrl, 160)} alt="" /><div><b>✓</b><span>Download started</span></div></div>}

    {pendingUndo && <div className="undoToast" role="status" aria-live="polite" onTouchStart={(event) => { undoSwipeStart.current = event.touches[0].clientX; }} onTouchEnd={(event) => {
      if (undoSwipeStart.current === null) return;
      const distance = event.changedTouches[0].clientX - undoSwipeStart.current;
      if (Math.abs(distance) > 40) dismissUndo();
      undoSwipeStart.current = null;
    }}><span>Image removed</span><button type="button" className="undoAction" onClick={() => void undoHistoryRemoval()}>Undo</button><button type="button" className="undoClose" onClick={dismissUndo} aria-label="Dismiss undo message">×</button></div>}

    <section className="how" id="how"><p className="eyebrow">THREE WAYS TO CREATE</p><h2>One editor.<br />Three flexible workflows.</h2><div className="howGrid"><article><span>01</span><h3>Single</h3><p>Edit one image with a direct natural-language instruction.</p></article><article><span>02</span><h3>Batch</h3><p>Apply one shared prompt to as many as {MAX_BATCH} images in one run. Every image is processed independently.</p></article><article><span>03</span><h3>Reference</h3><p>Guide a main image with a second visual reference plus your prompt.</p></article></div></section>
    <footer><a className="brand" href="#top"><span className="brandMark">P</span><span>Pixora</span><small className="versionBadge">v{APP_VERSION}</small></a><p>AI editing, without the complexity.</p><span>Powered by VModel V-Editor</span></footer>
  </main>;
}
