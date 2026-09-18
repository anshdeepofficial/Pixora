"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";

const ratios = ["default", "1:1", "3:2", "2:3", "9:16", "16:9", "3:4", "4:3"];
const MAX_BATCH = 50;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const APP_VERSION = "1.1.1";
const APP_VERSION_KEY = "pixora-app-version";

type Mode = "single" | "batch" | "reference";
type OutputTab = "result" | "history";
type ProgressState = { percent: number; label: string; state: "idle" | "working" | "done" | "error" };
type HistoryItem = { url: string; prompt: string; createdAt: string };
type BatchStatus = "ready" | "uploading" | "queued" | "processing" | "done" | "failed";
type BatchItem = {
  id: string;
  file?: File;
  preview: string;
  uploadedUrl?: string;
  taskId?: string;
  result?: string;
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
  const [singleResult, setSingleResult] = useState("");
  const [singleMessage, setSingleMessage] = useState("");
  const [singleProgress, setSingleProgress] = useState<ProgressState>({ percent: 0, label: "", state: "idle" });

  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [batchPrompt, setBatchPrompt] = useState("");
  const [batchRatio, setBatchRatio] = useState("default");
  const [batchBusy, setBatchBusy] = useState(false);
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
  const [referenceResult, setReferenceResult] = useState("");
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
  const [viewerIndex, setViewerIndex] = useState(0);
  const [pendingUndo, setPendingUndo] = useState<{ item: HistoryItem; index: number } | null>(null);
  const [versionNotice, setVersionNotice] = useState(false);
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
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      let parsed: HistoryItem[] = [];
      let hidden: string[] = [];
      try { parsed = saved ? JSON.parse(saved) as HistoryItem[] : []; } catch { parsed = []; }
      try { hidden = hiddenSaved ? JSON.parse(hiddenSaved) as string[] : []; } catch { hidden = []; }
      const hiddenUrls = new Set(hidden);
      const fresh = parsed.filter((item) => new Date(item.createdAt).getTime() > cutoff && !hiddenUrls.has(item.url));
      setHistory(fresh);
      localStorage.setItem("pixora-history", JSON.stringify(fresh));
    };
    prune();
    const timer = window.setInterval(prune, 60_000);
    fetch("/api/stats", { cache: "no-store" }).then((response) => response.ok ? response.json() : Promise.reject()).then((data: { totalGenerated?: number }) => {
      if (typeof data.totalGenerated === "number") setTotalGenerated(data.totalGenerated);
    }).catch(() => undefined);
    fetch("/api/recovery-history", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data: { history?: HistoryItem[]; historyVersion?: string }) => {
        if (!Array.isArray(data.history)) return;
        const resetHistory = Boolean(data.historyVersion && localStorage.getItem("pixora-history-version") !== data.historyVersion);
        if (data.historyVersion) localStorage.setItem("pixora-history-version", data.historyVersion);
        if (resetHistory) {
          localStorage.removeItem("pixora-history");
          localStorage.removeItem("pixora-history-hidden");
          setSelected([]);
        }
        setHistory((current) => {
          let hidden: string[] = [];
          try { hidden = JSON.parse(localStorage.getItem("pixora-history-hidden") || "[]") as string[]; } catch { hidden = []; }
          const hiddenUrls = new Set(hidden);
          const combined = [...data.history!, ...(resetHistory ? [] : current)].filter((item) => !hiddenUrls.has(item.url));
          const unique = Array.from(new Map(combined.map((item) => [item.url, item])).values())
            .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
          localStorage.setItem("pixora-history", JSON.stringify(unique));
          return unique;
        });
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
  const batchUploaded = batchItems.filter((item) => item.uploadedUrl).length;
  const batchResults = batchItems.filter((item) => item.result).map((item) => item.result!);
  const batchProgress: ProgressState = batchItems.length && (batchBusy || batchOverall > 0) ? {
    percent: batchOverall,
    state: batchBusy ? "working" : batchFailed === batchItems.length ? "error" : batchDone > 0 ? "done" : "idle",
    label: batchBusy ? `${batchDone} of ${batchItems.length} completed${batchFailed ? ` · ${batchFailed} failed` : ""}` : batchDone === batchItems.length ? `All ${batchDone} images completed` : `${batchUploaded}/${batchItems.length} uploaded · generation not started`,
  } : { percent: 0, label: "", state: "idle" };

  useEffect(() => {
    batchItemsRef.current = batchItems;
  }, [batchItems]);

  function addHistory(url: string, prompt: string, incrementGenerationCount = true) {
    const item = { url, prompt, createdAt: new Date().toISOString() };
    setHistory((current) => {
      const next = [item, ...current];
      localStorage.setItem("pixora-history", JSON.stringify(next));
      return next;
    });
    if (incrementGenerationCount) {
      setTotalGenerated((current) => current === null ? current : current + 1);
    }
  }

  async function uploadImage(image: File, onProgress?: (percentage: number) => void) {
    const blob = await upload(`pixora-inputs/${Date.now()}-${crypto.randomUUID()}-${image.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`, image, {
      access: "public",
      handleUploadUrl: "/api/upload",
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
    // One upload at a time keeps large 50-image selections within mobile browser memory limits.
    while (activeBatchUploadsRef.current < 1 && batchUploadQueueRef.current.length) {
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
      const status = await statusResponse.json() as { status?: string; output?: string[]; error?: string };
      if (!statusResponse.ok) throw new Error(status.error || "Could not check generation.");
      if (status.status === "succeeded" && status.output?.[0]) return status.output[0];
      if (status.status === "failed") throw new Error(status.error || "Generation failed");
      onStatus(status.status || "processing");
    }
    throw new Error("Generation took too long. Please try again.");
  }

  function taskPercent(status: string) {
    if (/queue|pending|start|prepar/i.test(status)) return 60;
    return 72;
  }

  async function generateSingle() {
    if (!validImage(singleFile) || !singlePrompt.trim()) { setSingleMessage("Choose an image and enter a prompt."); return; }
    setSingleBusy(true); setSingleMessage(""); setOutputTab("result");
    setSingleProgress({ percent: 1, label: "Starting upload…", state: "working" });
    try {
      const imageUrl = await uploadImage(singleFile!, (percentage) => setSingleProgress({ percent: Math.max(1, percentage * 0.45), label: `Uploading image · ${Math.round(percentage)}%`, state: "working" }));
      setSingleProgress({ percent: 50, label: "Creating V-Editor task…", state: "working" });
      const prompt = applyPreservation(singlePrompt, preserveFace, preservePose);
      const create = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageUrl, prompt, aspectRatio: singleRatio }) });
      const created = await create.json() as { taskId?: string; error?: string };
      if (!create.ok || !created.taskId) throw new Error(created.error || "Could not start generation");
      setSingleProgress({ percent: 60, label: "Task accepted by V-Editor…", state: "working" });
      const output = await pollTask(created.taskId, (status) => setSingleProgress({ percent: taskPercent(status), label: `V-Editor ${status.replace(/_/g, " ")}…`, state: "working" }));
      setSingleResult(output); addHistory(output, singlePrompt.trim());
      setSingleProgress({ percent: 100, label: "Completed", state: "done" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Something went wrong";
      setSingleMessage(detail); setSingleProgress((current) => ({ ...current, label: detail, state: "error" }));
    } finally { setSingleBusy(false); }
  }

  async function generateReference() {
    if (!validImage(referenceMain) || !validImage(referenceImage) || !referencePrompt.trim()) { setReferenceMessage("Choose both images and enter a prompt."); return; }
    setReferenceBusy(true); setReferenceMessage(""); setOutputTab("result");
    let mainUpload = 0; let refUpload = 0;
    const syncProgress = () => setReferenceProgress({ percent: Math.max(1, ((mainUpload + refUpload) / 2) * 0.45), label: `Uploading both images · ${Math.round((mainUpload + refUpload) / 2)}%`, state: "working" });
    setReferenceProgress({ percent: 1, label: "Starting uploads…", state: "working" });
    try {
      const [imageUrl, referenceImageUrl] = await Promise.all([
        uploadImage(referenceMain!, (percentage) => { mainUpload = percentage; syncProgress(); }),
        uploadImage(referenceImage!, (percentage) => { refUpload = percentage; syncProgress(); }),
      ]);
      setReferenceProgress({ percent: 50, label: "Creating reference edit task…", state: "working" });
      const prompt = applyPreservation(referencePrompt, preserveFace, preservePose, true);
      const create = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageUrl, referenceImageUrl, prompt, aspectRatio: referenceRatio }) });
      const created = await create.json() as { taskId?: string; error?: string };
      if (!create.ok || !created.taskId) throw new Error(created.error || "Could not start generation");
      setReferenceProgress({ percent: 60, label: "Reference task accepted…", state: "working" });
      const output = await pollTask(created.taskId, (status) => setReferenceProgress({ percent: taskPercent(status), label: `V-Editor ${status.replace(/_/g, " ")}…`, state: "working" }));
      setReferenceResult(output); addHistory(output, referencePrompt.trim());
      setReferenceProgress({ percent: 100, label: "Completed", state: "done" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Something went wrong";
      setReferenceMessage(detail); setReferenceProgress((current) => ({ ...current, label: detail, state: "error" }));
    } finally { setReferenceBusy(false); }
  }

  async function generateBatch() {
    if (!batchItems.length || !batchPrompt.trim()) { setBatchMessage("Add at least one image and enter a shared prompt."); return; }
    if (batchItems.length > MAX_BATCH) { setBatchMessage(`Maximum ${MAX_BATCH} images per batch.`); return; }

    setBatchBusy(true);
    setBatchMessage("");
    setOutputTab("result");

    // Keep only lightweight IDs in this function. Holding a snapshot of every BatchItem
    // would also hold all 50 File objects until the whole batch finishes.
    const itemIds = batchItemsRef.current.map((item) => item.id);
    const prompt = applyPreservation(batchPrompt, preserveFace, preservePose);

    setBatchItems((current) => {
      const next = current.map((item) => ({
        ...item,
        taskId: undefined,
        result: undefined,
        error: undefined,
        progress: item.uploadedUrl ? 48 : 0,
        label: item.uploadedUrl ? "Uploaded · waiting to generate" : "Waiting in queue",
        status: item.uploadedUrl ? "queued" as BatchStatus : "ready" as BatchStatus,
      }));
      batchItemsRef.current = next;
      return next;
    });

    try {
      // Stream the batch end-to-end one image at a time:
      // upload -> create V-Editor task -> poll -> show result -> release local source -> next.
      // The first result therefore does not wait for the other 49 uploads.
      for (let index = 0; index < itemIds.length; index++) {
        const id = itemIds[index];
        const item = batchItemsRef.current.find((entry) => entry.id === id);
        if (!item) continue;

        try {
          updateBatchItem(id, {
            progress: item.uploadedUrl ? 48 : Math.max(1, item.progress),
            label: item.uploadedUrl ? "Uploaded · creating task" : `Uploading image ${index + 1} of ${itemIds.length}…`,
            status: item.uploadedUrl ? "queued" : "uploading",
            error: undefined,
          });

          const uploadedUrl = item.uploadedUrl || await startBatchUpload(item);

          // Once Vercel/ImageKit has the source, do not keep the original File/blob URL alive.
          // This is the key memory release for large 50-image selections.
          releaseBatchLocalSource(id, uploadedUrl);
          updateBatchItem(id, { uploadedUrl, progress: 50, label: "Creating V-Editor task…", status: "queued" });

          // Submit only this image. Never build a 50-URL request or wait for all uploads first.
          const create = await fetch("/api/generate-batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageUrls: [uploadedUrl], prompt, aspectRatio: batchRatio }),
          });
          const created = await create.json() as { tasks?: Array<{ index: number; taskId?: string; error?: string }>; error?: string };
          const task = created.tasks?.[0];

          if (!create.ok && !task?.taskId) throw new Error(created.error || task?.error || "Could not start generation");
          if (!task?.taskId) throw new Error(task?.error || created.error || "Could not start this image.");

          updateBatchItem(id, { taskId: task.taskId, progress: 60, label: "Task accepted", status: "queued" });

          const output = await pollTask(task.taskId, (status) => updateBatchItem(id, {
            progress: taskPercent(status),
            label: status.replace(/_/g, " "),
            status: "processing",
          }));

          // Replace the source thumbnail with the finished image immediately.
          updateBatchItem(id, {
            result: output,
            preview: output,
            progress: 100,
            label: "Completed",
            status: "done",
          });
          addHistory(output, batchPrompt.trim(), false);
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Generation failed";
          updateBatchItem(id, { progress: 100, label: detail, status: "failed", error: detail });
        }
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

  function downloadProxyUrl(url: string, index = 1, disposition: "attachment" | "inline" = "attachment") {
    const params = new URLSearchParams({ url, filename: `pixora-${index}`, disposition });
    return `/api/download?${params.toString()}`;
  }

  async function fetchImage(url: string) {
    const response = await fetch(downloadProxyUrl(url), { cache: "no-store" });
    if (!response.ok) {
      let detail = "Could not download this image.";
      try { const data = await response.json() as { error?: string }; if (data.error) detail = data.error; } catch {}
      throw new Error(detail);
    }
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error("The server did not return an image.");
    return blob;
  }

  function extensionForBlob(blob: Blob) {
    if (blob.type.includes("jpeg")) return "jpg";
    if (blob.type.includes("webp")) return "webp";
    if (blob.type.includes("gif")) return "gif";
    if (blob.type.includes("avif")) return "avif";
    return "png";
  }

  function saveBlob(blob: Blob, name: string) {
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href; anchor.download = name; anchor.style.display = "none";
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 5000);
  }

  async function downloadOne(url: string, index = 1) {
    setDownloadProgress({ percent: 10, label: "Preparing image…", state: "working" });
    try {
      const blob = await fetchImage(url);
      setDownloadProgress({ percent: 85, label: "Saving image…", state: "working" });
      saveBlob(blob, `pixora-${index}.${extensionForBlob(blob)}`);
      setDownloadedUrls((current) => current.includes(url) ? current : [...current, url]);
      setDownloadNoticeUrl(url);
      window.setTimeout(() => setDownloadNoticeUrl(""), 1600);
      setDownloadProgress({ percent: 100, label: "Downloaded", state: "done" });
      window.setTimeout(() => setDownloadProgress({ percent: 0, label: "", state: "idle" }), 1800);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Download failed";
      setSingleMessage(detail);
      setDownloadProgress({ percent: 100, label: detail, state: "error" });
    }
  }

  async function downloadMany(urls: string[], kind: "zip" | "separate") {
    if (!urls.length) return;
    if (kind === "separate") {
      for (let index = 0; index < urls.length; index++) {
        setDownloadProgress({ percent: (index / urls.length) * 100, label: `Downloading ${index + 1} of ${urls.length}…`, state: "working" });
        const blob = await fetchImage(urls[index]);
        saveBlob(blob, `pixora-${index + 1}.${extensionForBlob(blob)}`);
        setDownloadedUrls((current) => current.includes(urls[index]) ? current : [...current, urls[index]]);
        setDownloadProgress({ percent: ((index + 1) / urls.length) * 100, label: `Downloaded ${index + 1} of ${urls.length}`, state: "working" });
      }
      setDownloadProgress({ percent: 100, label: `Downloaded ${urls.length} images`, state: "done" });
      return;
    }
    let fetched = 0;
    const images = await Promise.all(urls.map(async (url, index) => {
      const blob = await fetchImage(url);
      fetched += 1;
      setDownloadProgress({ percent: (fetched / urls.length) * 85, label: `Adding ${fetched} of ${urls.length} images…`, state: "working" });
      return { index, blob };
    }));
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    images.forEach(({ index, blob }) => zip.file(`pixora-${index + 1}.${extensionForBlob(blob)}`, blob));
    const archive = await zip.generateAsync({ type: "blob" }, (metadata) => {
      setDownloadProgress({ percent: 85 + metadata.percent * 0.15, label: `Creating ZIP · ${Math.round(metadata.percent)}%`, state: "working" });
    });
    saveBlob(archive, "pixora-images.zip");
    setDownloadedUrls((current) => Array.from(new Set([...current, ...urls])));
    setDownloadProgress({ percent: 100, label: "ZIP downloaded", state: "done" });
  }

  async function downloadSelected(kind: "zip" | "separate") {
    if (!selected.length) return;
    setDownloading(true); setDownloadMenu(false); setSingleMessage("");
    try { await downloadMany(selected, kind); } catch (error) { setSingleMessage(error instanceof Error ? error.message : "Download failed"); }
    finally {
      setDownloading(false);
      window.setTimeout(() => setDownloadProgress({ percent: 0, label: "", state: "idle" }), 1800);
    }
  }

  async function downloadBatch(kind: "zip" | "separate") {
    setBatchDownloading(true); setBatchMessage("");
    try { await downloadMany(batchResults, kind); } catch (error) { setBatchMessage(error instanceof Error ? error.message : "Download failed"); }
    finally {
      setBatchDownloading(false);
      window.setTimeout(() => setDownloadProgress({ percent: 0, label: "", state: "idle" }), 1800);
    }
  }

  function clearHistory() {
    if (isProcessing) return;
    const hidden = readHiddenHistory();
    localStorage.setItem("pixora-history-hidden", JSON.stringify(Array.from(new Set([...hidden, ...history.map((item) => item.url)]))));
    dismissUndo();
    localStorage.removeItem("pixora-history"); setHistory([]); setSelected([]); setSelecting(false); setDownloadMenu(false); setOutputTab("history");
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
    setSelected((current) => current.filter((url) => url !== item.url));
    setPendingUndo({ item, index });
    undoTimerRef.current = window.setTimeout(() => {
      setPendingUndo(null);
      undoTimerRef.current = null;
    }, 5000);
  }

  function undoHistoryRemoval() {
    if (!pendingUndo) return;
    const { item, index } = pendingUndo;
    localStorage.setItem("pixora-history-hidden", JSON.stringify(readHiddenHistory().filter((url) => url !== item.url)));
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

  function openViewer(urls: string[], index: number) {
    setViewerUrls(urls);
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

  return <main className="shell">
    <nav className="nav"><a className="brand" href="#top" aria-label="Pixora home"><span className="brandMark">P</span><span>Pixora</span><small className="versionBadge">v{APP_VERSION}</small></a><div className="navActions"><span className="statusDot"><i /> V-Editor connected</span><a href="#how">How it works</a></div></nav>
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
          <div className="controls"><div className="controlHeading"><span className="step">02</span><h2>Describe your edit</h2></div><label className="promptLabel" htmlFor="single-prompt">YOUR PROMPT</label><textarea id="single-prompt" value={singlePrompt} onChange={(e) => setSinglePrompt(e.target.value)} placeholder="Make the scene look like golden hour, keep the person unchanged…" maxLength={700} /><div className="promptMeta"><button type="button" onClick={() => setSinglePrompt("Replace the background with a warm, cinematic sunset while keeping the subject unchanged.")}>✦ Try an example</button><span>{singlePrompt.length}/700</span></div><RatioPicker value={singleRatio} onChange={setSingleRatio} /><PreserveControls preserveFace={preserveFace} preservePose={preservePose} onFace={setPreserveFace} onPose={setPreservePose} /><ProgressBar progress={singleProgress} /><button type="button" className="generate" disabled={!singleFile || !singlePrompt.trim() || singleBusy} onClick={generateSingle}>{singleBusy ? <><span className="spinner" /> Working…</> : <>Generate edit <span>→</span></>}</button>{singleMessage && <p className="error">{singleMessage}</p>}<p className="fineprint">Same Face and Same Pose are prompt-level preservation locks; exact model output can still vary.</p></div>
        </div>
      </>}

      {mode === "batch" && <>
        <div className="studioTop"><div><span className="step">01</span><h2>Batch edit · {batchItems.length}/{MAX_BATCH}</h2></div><span className="privacy">◆ One prompt, separate generations</span></div>
        <div className="workspace batchWorkspace">
          <div className="batchPane">
            <div className="batchToolbar"><strong>Selected images</strong><div>{batchItems.length > 0 && <button type="button" onClick={clearBatch} disabled={isProcessing}>Clear all</button>}<button type="button" onClick={() => batchInputRef.current?.click()} disabled={isProcessing || batchItems.length >= MAX_BATCH}>+ Add images</button></div></div>
            <input ref={batchInputRef} disabled={isProcessing} type="file" multiple accept="image/png,image/jpeg,image/webp" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { if (e.target.files) addBatchFiles(e.target.files); e.target.value = ""; }} />
            {batchItems.length === 0 ? <div className="dropzone batchDropzone" onClick={() => batchInputRef.current?.click()} onDrop={batchDrop} onDragOver={(e) => e.preventDefault()} role="button" tabIndex={0}><UploadEmpty title={`Drop up to ${MAX_BATCH} images`} subtitle="One shared prompt will be applied to every image" button="Choose images" /></div> : <div className="batchGrid" onDrop={batchDrop} onDragOver={(e) => e.preventDefault()}>{batchItems.map((item, index) => <article key={item.id} className={`batchCard ${item.status}`}><div className="batchThumb"><img src={item.result || item.preview} alt={item.result ? `Generated result ${index + 1}` : `Batch source ${index + 1}`} loading="lazy" decoding="async" />{!batchBusy && <button type="button" onClick={() => removeBatchItem(item.id)} aria-label={`Remove image ${index + 1}`}>×</button>}</div><div className="batchCardMeta"><span>{index + 1}</span><div><strong>{item.status === "done" ? "Done" : item.status === "failed" ? "Failed" : item.label}</strong><div className="miniProgress"><i style={{ width: `${item.progress}%` }} /></div></div><b>{Math.round(item.progress)}%</b></div>{item.result && <div className="batchResultActions"><button type="button" onClick={() => downloadOne(item.result!, index + 1)}>↓ Download</button><a href={item.result} target="_blank" rel="noopener noreferrer">Open ↗</a></div>}</article>)}</div>}
          </div>
          <div className="controls"><div className="controlHeading"><span className="step">02</span><h2>Shared batch prompt</h2></div><label className="promptLabel" htmlFor="batch-prompt">PROMPT FOR ALL IMAGES</label><textarea id="batch-prompt" value={batchPrompt} onChange={(e) => setBatchPrompt(e.target.value)} placeholder="Apply the same edit to every selected image…" maxLength={700} /><div className="promptMeta"><button type="button" onClick={() => setBatchPrompt("Give every image a clean cinematic color grade while preserving the subject and composition.")}>✦ Try an example</button><span>{batchPrompt.length}/700</span></div><RatioPicker value={batchRatio} onChange={setBatchRatio} /><PreserveControls preserveFace={preserveFace} preservePose={preservePose} onFace={setPreserveFace} onPose={setPreservePose} /><ProgressBar progress={batchProgress} /><button type="button" className="generate" disabled={!batchItems.length || !batchPrompt.trim() || batchBusy} onClick={generateBatch}>{batchBusy ? <><span className="spinner" /> Processing {batchDone}/{batchItems.length}</> : <>Generate {batchItems.length || ""} image{batchItems.length === 1 ? "" : "s"} <span>→</span></>}</button>{batchMessage && <p className="error">{batchMessage}</p>}<p className="fineprint">Each image is sent to V-Editor as its own independent request.</p></div>
        </div>
      </>}

      {mode === "reference" && <>
        <div className="studioTop"><div><span className="step">01</span><h2>Reference-guided edit</h2></div><span className="privacy">◆ Main image + reference</span></div>
        <div className="workspace referenceWorkspace">
          <div className="referenceUploads">
            <div><span className="uploadCaption">MAIN IMAGE</span><div className={`dropzone referenceDropzone ${referenceMainPreview ? "hasImage" : ""}`} onClick={() => referenceMainRef.current?.click()} onDrop={(e) => referenceDrop("main", e)} onDragOver={(e) => e.preventDefault()} role="button" tabIndex={0}><input ref={referenceMainRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => setReferenceFile("main", e.target.files?.[0])} />{referenceMainPreview ? <><img src={referenceMainPreview} alt="Main input" /><button type="button" className="replace" onClick={(e) => { e.stopPropagation(); referenceMainRef.current?.click(); }}>Replace</button></> : <UploadEmpty title="Main image" subtitle="The image you want to edit" />}</div></div>
            <div><span className="uploadCaption">REFERENCE IMAGE</span><div className={`dropzone referenceDropzone ${referencePreview ? "hasImage" : ""}`} onClick={() => referenceStyleRef.current?.click()} onDrop={(e) => referenceDrop("reference", e)} onDragOver={(e) => e.preventDefault()} role="button" tabIndex={0}><input ref={referenceStyleRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => setReferenceFile("reference", e.target.files?.[0])} />{referencePreview ? <><img src={referencePreview} alt="Reference input" /><button type="button" className="replace" onClick={(e) => { e.stopPropagation(); referenceStyleRef.current?.click(); }}>Replace</button></> : <UploadEmpty title="Reference image" subtitle="Style, pose, look, or visual guide" />}</div></div>
          </div>
          <div className="controls"><div className="controlHeading"><span className="step">02</span><h2>Tell V-Editor what to borrow</h2></div><label className="promptLabel" htmlFor="reference-prompt">YOUR PROMPT</label><textarea id="reference-prompt" value={referencePrompt} onChange={(e) => setReferencePrompt(e.target.value)} placeholder="Use the reference image's lighting and color style while keeping the person from the main image…" maxLength={700} /><div className="promptMeta"><button type="button" onClick={() => setReferencePrompt("Use the reference image's visual style and lighting while preserving the main subject's identity and composition.")}>✦ Try an example</button><span>{referencePrompt.length}/700</span></div><RatioPicker value={referenceRatio} onChange={setReferenceRatio} /><PreserveControls preserveFace={preserveFace} preservePose={preservePose} onFace={setPreserveFace} onPose={setPreservePose} /><ProgressBar progress={referenceProgress} /><button type="button" className="generate" disabled={!referenceMain || !referenceImage || !referencePrompt.trim() || referenceBusy} onClick={generateReference}>{referenceBusy ? <><span className="spinner" /> Working…</> : <>Generate reference edit <span>→</span></>}</button>{referenceMessage && <p className="error">{referenceMessage}</p>}<p className="fineprint">With a lock enabled, the main image stays authoritative for identity/pose; reference remains guidance.</p></div>
        </div>
      </>}

      <div className="output">
        <div className="tabs"><div><button type="button" className={outputTab === "result" ? "active" : ""} onClick={() => setOutputTab("result")}>Result</button><button type="button" className={outputTab === "history" ? "active" : ""} onClick={() => setOutputTab("history")}>24h History <span>{history.length}</span></button></div>{history.length > 0 && <button type="button" className="clearHistory" disabled={isProcessing} onClick={clearHistory}>Clear history</button>}</div>
        <ProgressBar progress={downloadProgress} />
        {outputTab === "history" && history.length > 0 && <div className="downloadBar"><div><button type="button" className={`selectToggle ${selecting ? "active" : ""}`} onClick={() => { setSelecting(!selecting); setSelected([]); setDownloadMenu(false); }}>{selecting ? "Done" : "Select"}</button>{selecting && <button type="button" className="selectAll" onClick={() => setSelected(selected.length === history.length ? [] : history.map((item) => item.url))}>{selected.length === history.length ? "Clear all" : "Select all"}</button>}</div>{selecting && <div className="downloadWrap"><button type="button" className="downloadSelected" disabled={!selected.length || downloading} onClick={() => setDownloadMenu(!downloadMenu)}>{downloading ? "Preparing…" : `Download ${selected.length || ""}`} <span>⌄</span></button>{downloadMenu && <div className="downloadMenu"><button type="button" onClick={() => void downloadSelected("zip")}><b>ZIP archive</b><small>One file with all selected images</small></button><button type="button" onClick={() => void downloadSelected("separate")}><b>Separate files</b><small>Trigger each selected download separately</small></button></div>}</div>}</div>}

        {outputTab === "result" ? mode === "batch" ? <div className="batchOutput">
          {batchResults.length ? <>
            <div className="batchOutputHead"><div><strong>{batchResults.length} result{batchResults.length === 1 ? "" : "s"} ready</strong><small>{batchFailed ? `${batchFailed} failed` : "Batch completed"}</small></div><div><button type="button" disabled={batchDownloading} onClick={() => void downloadBatch("zip")}>{batchDownloading ? "Preparing…" : "↓ Download ZIP"}</button><button type="button" disabled={batchDownloading} onClick={() => void downloadBatch("separate")}>Separate files</button></div></div>
            <div className="batchOutputGrid">{batchItems.filter((item) => item.result).map((item, index) => <article key={item.id}>
              <div className={`downloadVisual ${downloadedUrls.includes(item.result!) ? "downloaded" : ""}`} onClick={() => openViewer(batchResults, index)} role="button" tabIndex={0}><img src={item.result} alt={`Batch result ${index + 1}`} /><span className="downloadCheck">✓<small>Downloaded</small></span></div>
              <div><button type="button" onClick={() => void downloadOne(item.result!, index + 1)}>↓ Download</button><a href={item.result} target="_blank" rel="noopener noreferrer">Open full size ↗</a></div>
            </article>)}</div>
          </> : <div className="emptyResult"><span>✦</span><h3>Your batch results will appear here</h3><p>Add up to {MAX_BATCH} images, use one prompt, and generate them together.</p></div>}
        </div> : <div className="resultArea">
          {activeResult ? <div className="resultCard">
            <div className={`downloadVisual ${downloadedUrls.includes(activeResult) ? "downloaded" : ""}`} onClick={() => {
              const index = history.findIndex((item) => item.url === activeResult);
              openViewer(index >= 0 ? history.map((item) => item.url) : [activeResult], index >= 0 ? index : 0);
            }} role="button" tabIndex={0}><img src={activeResult} alt="AI generated edit" /><span className="downloadCheck">✓<small>Downloaded</small></span></div>
            <div className="resultActions"><button type="button" onClick={() => void downloadOne(activeResult)}>↓ Download</button><a href={activeResult} target="_blank" rel="noopener noreferrer">Open full size ↗</a></div>
          </div> : <div className="emptyResult"><span>✦</span><h3>Your creation will appear here</h3><p>{mode === "reference" ? "Add a main image, reference image, and prompt." : "Upload an image, write a prompt, and let Pixora do the rest."}</p></div>}
        </div> : <div className={`historyGrid ${selecting ? "selecting" : ""}`}>
          {history.length ? history.map((item, index) => <article key={item.createdAt} className={selected.includes(item.url) ? "selected" : ""} onClick={() => selecting ? toggleSelection(item.url) : openViewer(history.map((entry) => entry.url), index)} role="button" tabIndex={0} onKeyDown={(event) => event.key === "Enter" && (selecting ? toggleSelection(item.url) : openViewer(history.map((entry) => entry.url), index))}>
            {selecting && <span className="check">{selected.includes(item.url) ? "✓" : ""}</span>}
            {!selecting && <button type="button" className="historyDelete" disabled={isProcessing} aria-label="Remove image from history" onClick={(event) => { event.stopPropagation(); removeHistoryItem(item, index); }}>×</button>}
            <div className={`downloadVisual ${downloadedUrls.includes(item.url) ? "downloaded" : ""}`}><img src={item.url} alt={item.prompt} /><span className="downloadCheck">✓<small>Downloaded</small></span></div>
            <div className="historyCaption"><span>{item.prompt}</span>{!selecting && <button type="button" aria-label="Download image" onClick={(event) => { event.stopPropagation(); void downloadOne(item.url, index + 1); }}>↓</button>}</div>
          </article>) : <div className="emptyResult"><h3>No edits yet</h3><p>Edits stay on this device for 24 hours.</p></div>}
        </div>}
      </div>
    </section>

    {viewerUrls.length > 0 && <div className="imageViewer" role="dialog" aria-modal="true" aria-label="Image preview" onClick={() => setViewerUrls([])}>
      <button type="button" className="viewerClose" onClick={() => setViewerUrls([])} aria-label="Close preview">×</button>
      {viewerUrls.length > 1 && <button type="button" className="viewerPrevious" onClick={(event) => { event.stopPropagation(); moveViewer(-1); }} aria-label="Previous image">‹</button>}
      <div className="viewerCanvas" onClick={(event) => event.stopPropagation()} onTouchStart={(event) => { swipeStart.current = event.touches[0].clientX; }} onTouchEnd={(event) => {
        if (swipeStart.current === null) return;
        const distance = event.changedTouches[0].clientX - swipeStart.current;
        if (Math.abs(distance) > 45 && viewerUrls.length > 1) moveViewer(distance > 0 ? -1 : 1);
        swipeStart.current = null;
      }}>
        <img src={viewerUrls[viewerIndex]} alt={`Preview ${viewerIndex + 1} of ${viewerUrls.length}`} />
        <span>{viewerIndex + 1} / {viewerUrls.length}</span>
      </div>
      {viewerUrls.length > 1 && <button type="button" className="viewerNext" onClick={(event) => { event.stopPropagation(); moveViewer(1); }} aria-label="Next image">›</button>}
    </div>}

    {downloadNoticeUrl && <div className="downloadNotice" role="status"><img src={downloadNoticeUrl} alt="" /><div><b>✓</b><span>Downloaded</span></div></div>}

    {pendingUndo && <div className="undoToast" role="status" aria-live="polite" onTouchStart={(event) => { undoSwipeStart.current = event.touches[0].clientX; }} onTouchEnd={(event) => {
      if (undoSwipeStart.current === null) return;
      const distance = event.changedTouches[0].clientX - undoSwipeStart.current;
      if (Math.abs(distance) > 40) dismissUndo();
      undoSwipeStart.current = null;
    }}><span>Image removed</span><button type="button" className="undoAction" onClick={undoHistoryRemoval}>Undo</button><button type="button" className="undoClose" onClick={dismissUndo} aria-label="Dismiss undo message">×</button></div>}

    <section className="how" id="how"><p className="eyebrow">THREE WAYS TO CREATE</p><h2>One editor.<br />Three flexible workflows.</h2><div className="howGrid"><article><span>01</span><h3>Single</h3><p>Edit one image with a direct natural-language instruction.</p></article><article><span>02</span><h3>Batch</h3><p>Apply one shared prompt to as many as {MAX_BATCH} images in one run. Every image is processed independently.</p></article><article><span>03</span><h3>Reference</h3><p>Guide a main image with a second visual reference plus your prompt.</p></article></div></section>
    <footer><a className="brand" href="#top"><span className="brandMark">P</span><span>Pixora</span><small className="versionBadge">v{APP_VERSION}</small></a><p>AI editing, without the complexity.</p><span>Powered by VModel V-Editor</span></footer>
  </main>;
}
