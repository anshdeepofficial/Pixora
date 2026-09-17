"use client";

import { useEffect } from "react";
import { upload, uploadResult } from "../lib/imagekit-upload-client";

type NormalizedCrop = { x: number; y: number; width: number; height: number };
type Panel = { left: number; top: number; width: number; height: number };
type PanelSize = { width: number; height: number };
type Layout = { width: number; height: number; panels: Panel[] };
type BatchPayload = {
  imageUrls?: string[];
  prompt?: string;
  aspectRatio?: string;
};
type BatchTask = { index: number; taskId?: string; error?: string };
type PreparedGroup = {
  originalIndexes: number[];
  imageUrl?: string;
  crops: NormalizedCrop[];
  aspectRatio: string;
  resultResolution: 0 | 1 | 2;
  prompt: string;
  error?: string;
};
type SyntheticTask = {
  realTaskId: string;
  crop: NormalizedCrop;
  panelIndex: number;
  pairKey: string;
  createdAt: number;
};
type PendingSyntheticTask = {
  entry?: SyntheticTask;
  error?: string;
};
type TaskPoll = { status?: string; output?: string[]; error?: string };

type PairProgress = {
  percent: number;
  detail: string;
};

const PAIR_PREFIX = "pxpair_";
const PAIR_PROGRESS_EVENT = "pixora:batch-pair-progress";
const SYNTHETIC_TASK_KEY = "pixora-synthetic-pair-tasks-v1";
const BRIDGE_BATCH_KEY = "pixora-bridge-last-batch-v1";
const SYNTHETIC_TTL = 24 * 60 * 60 * 1000;
const SEAM = 8;
const MAX_PAIR_UPLOAD_BYTES = 24 * 1024 * 1024;
// 3072 is large enough to keep two typical 1080p sources at or near their native pixel size,
// while keeping PNG encoding/upload memory reasonable on mobile browsers.
const MAX_CANVAS_SIDE = 3072;
const MAX_CANVAS_PIXELS = 8_500_000;
const FACE_LOCK_MARKER = "Preserve the exact facial identity";
const POSE_LOCK_MARKER = "Preserve the exact body pose";
const BATCH_DIRECTIVE = "BATCH COLLAGE: The input is a simple two-panel collage made from two separate, uncropped source photos. The user's instruction above is the primary edit request. Treat each panel as an independent image and apply that same requested edit separately to each panel. IMPORTANT: if the user's wording refers to one person or character in the singular, apply that instruction consistently and independently to EVERY visible person or character inside each panel, unless the user explicitly identifies someone to exclude. Do not leave a second person unchanged merely because the prompt uses singular wording. Never merge, blend, swap, copy, or transfer faces, identities, hair, bodies, clothes, poses, backgrounds, or objects between panels. Keep each subject in its own panel. Do not invent a third person. Keep the panel boundary and each panel's complete framing stable.";
const FACE_PANEL_DIRECTIVE = "FACE LOCK FOR COLLAGE: For each panel independently, preserve that panel's original person's recognizable identity with very high priority. Keep facial structure, eyes, nose, lips, skin tone, age appearance, hairstyle, hairline, and other unique identity features consistent. Never use the face or identity from the other panel.";
const POSE_PANEL_DIRECTIVE = "POSE LOCK FOR COLLAGE: For each panel independently, preserve that panel's original head angle, body pose, limb positions, gaze direction, camera angle, crop, framing, and composition unless the user's primary edit explicitly makes a small change unavoidable. Never copy the pose from the other panel.";

function requestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function emitPairProgress(progress: PairProgress) {
  window.dispatchEvent(new CustomEvent<PairProgress>(PAIR_PROGRESS_EVENT, { detail: progress }));
}

function restoreSyntheticTasks() {
  const map = new Map<string, SyntheticTask>();
  try {
    const raw = JSON.parse(localStorage.getItem(SYNTHETIC_TASK_KEY) || "[]") as Array<[string, SyntheticTask]>;
    const cutoff = Date.now() - SYNTHETIC_TTL;
    for (const entry of Array.isArray(raw) ? raw : []) {
      const [id, task] = entry || [];
      if (!id?.startsWith(PAIR_PREFIX) || !task?.realTaskId || !task?.crop || Number(task.createdAt || 0) < cutoff) continue;
      map.set(id, task);
    }
  } catch {}
  return map;
}

function persistSyntheticTasks(tasks: Map<string, SyntheticTask>) {
  try {
    localStorage.setItem(SYNTHETIC_TASK_KEY, JSON.stringify(Array.from(tasks.entries())));
  } catch {}
}

function persistBridgeBatch(sourceImageUrls: string[], payload: BatchPayload, tasks: BatchTask[], requestCount: number) {
  try {
    localStorage.setItem(BRIDGE_BATCH_KEY, JSON.stringify({
      at: Date.now(),
      sourceImageUrls,
      prompt: payload.prompt || "",
      aspectRatio: payload.aspectRatio || "default",
      tasks,
      vmodelRequestCount: requestCount,
    }));
  } catch {}
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode the batch image.")), type, quality);
  });
}

function currentLocalPreviewUrls(expectedCount: number) {
  const cards = Array.from(document.querySelectorAll<HTMLElement>(".batchCard"))
    .filter((card) => !card.classList.contains("failed"));
  return cards
    .map((card) => card.querySelector<HTMLImageElement>(".batchThumb img")?.src || "")
    .filter((source) => source.startsWith("blob:") || source.startsWith("data:"))
    .slice(0, expectedCount);
}

async function fetchBitmap(source: string, originalFetch: typeof window.fetch) {
  // Batch thumbnails point at the original local File via an object URL. Reading that object URL
  // stays entirely inside the browser and avoids downloading an image we just uploaded.
  if (source.startsWith("blob:") || source.startsWith("data:")) {
    const response = await originalFetch(source);
    if (!response.ok) throw new Error("Could not read the local batch source.");
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error("A local batch source is not an image.");
    return createImageBitmap(blob);
  }

  // Compatibility fallback if a local preview cannot be resolved.
  const params = new URLSearchParams({ url: source, filename: "pixora-pair-source", disposition: "inline" });
  const response = await originalFetch(`/api/download?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not read a batch source (${response.status}).`);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("A batch source did not return an image.");
  return createImageBitmap(blob);
}

function safeScale(width: number, height: number) {
  const sideScale = MAX_CANVAS_SIDE / Math.max(width, height);
  const pixelScale = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height));
  return Math.min(1, sideScale, pixelScale);
}

function scaleLayout(width: number, height: number, panels: Panel[]): Layout {
  const scale = safeScale(width, height);
  if (scale >= 0.9999) return { width, height, panels };
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    panels: panels.map((panel) => ({
      left: Math.round(panel.left * scale),
      top: Math.round(panel.top * scale),
      width: Math.max(1, Math.round(panel.width * scale)),
      height: Math.max(1, Math.round(panel.height * scale)),
    })),
  };
}

function horizontalCandidate(a: PanelSize, b: PanelSize) {
  const width = a.width + SEAM + b.width;
  const height = Math.max(a.height, b.height);
  return {
    width,
    height,
    panels: [
      { left: 0, top: Math.round((height - a.height) / 2), width: a.width, height: a.height },
      { left: a.width + SEAM, top: Math.round((height - b.height) / 2), width: b.width, height: b.height },
    ],
  };
}

function verticalCandidate(a: PanelSize, b: PanelSize) {
  const width = Math.max(a.width, b.width);
  const height = a.height + SEAM + b.height;
  return {
    width,
    height,
    panels: [
      { left: Math.round((width - a.width) / 2), top: 0, width: a.width, height: a.height },
      { left: Math.round((width - b.width) / 2), top: a.height + SEAM, width: b.width, height: b.height },
    ],
  };
}

function chooseCompactLayout(a: PanelSize, b: PanelSize) {
  const horizontal = horizontalCandidate(a, b);
  const vertical = verticalCandidate(a, b);
  const horizontalScale = safeScale(horizontal.width, horizontal.height);
  const verticalScale = safeScale(vertical.width, vertical.height);

  // First prefer the layout that keeps more of the original source pixels. If both can remain
  // full-size, prefer the more compact/square canvas so V-Editor allocates resolution efficiently.
  const raw = Math.abs(horizontalScale - verticalScale) > 0.01
    ? (horizontalScale > verticalScale ? horizontal : vertical)
    : (Math.abs(Math.log(horizontal.width / horizontal.height)) <= Math.abs(Math.log(vertical.width / vertical.height)) ? horizontal : vertical);

  return scaleLayout(raw.width, raw.height, raw.panels);
}

function choosePanels(a: ImageBitmap, b: ImageBitmap) {
  // The temporary collage must not apply the requested result ratio to either source.
  // Each panel therefore keeps the source image's complete, uncropped aspect ratio.
  return chooseCompactLayout(
    { width: a.width, height: a.height },
    { width: b.width, height: b.height },
  );
}

function drawContained(context: CanvasRenderingContext2D, bitmap: ImageBitmap, panel: Panel) {
  context.fillStyle = "#ffffff";
  context.fillRect(panel.left, panel.top, panel.width, panel.height);

  const sourceRatio = bitmap.width / bitmap.height;
  const panelRatio = panel.width / panel.height;
  let width = panel.width;
  let height = panel.height;
  if (sourceRatio > panelRatio) height = width / sourceRatio;
  else width = height * sourceRatio;

  const left = panel.left + (panel.width - width) / 2;
  const top = panel.top + (panel.height - height) / 2;
  context.drawImage(bitmap, left, top, width, height);
}

function buildPairPrompt(prompt: string) {
  const base = prompt.trim();
  const additions = [BATCH_DIRECTIVE];
  if (base.includes(FACE_LOCK_MARKER)) additions.push(FACE_PANEL_DIRECTIVE);
  if (base.includes(POSE_LOCK_MARKER)) additions.push(POSE_PANEL_DIRECTIVE);
  return `${base}\n\n${additions.join("\n\n")}`;
}

async function makeComposite(
  sourceA: string,
  sourceB: string,
  originalFetch: typeof window.fetch,
  onProgress?: (percent: number, detail: string) => void,
) {
  onProgress?.(5, "Reading the two original images locally…");
  const [a, b] = await Promise.all([fetchBitmap(sourceA, originalFetch), fetchBitmap(sourceB, originalFetch)]);
  try {
    onProgress?.(20, "Choosing a no-crop layout from the original dimensions…");
    const layout = choosePanels(a, b);
    const canvas = document.createElement("canvas");
    canvas.width = layout.width;
    canvas.height = layout.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas is not available in this browser.");

    // Plain browser canvas only: no AI, face detection, alignment, enhancement, segmentation,
    // blending or crop-normalisation happens before V-Editor.
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    drawContained(context, a, layout.panels[0]);
    drawContained(context, b, layout.panels[1]);

    onProgress?.(42, `Building no-crop ${canvas.width}×${canvas.height} collage…`);
    let blob = await canvasBlob(canvas, "image/png");
    let extension = "png";
    // Keep normal pairs lossless. Only unusually detailed PNGs that exceed the safe upload
    // size use a visually lossless transport fallback instead of failing before V-Editor.
    if (blob.size > MAX_PAIR_UPLOAD_BYTES) {
      blob = await canvasBlob(canvas, "image/jpeg", 0.98);
      extension = "jpg";
    }
    const file = new File([blob], `pixora-pair-${crypto.randomUUID()}.${extension}`, { type: blob.type });

    onProgress?.(55, "Uploading the lossless smart batch…");
    const uploaded = await upload(`pixora-inputs/pairs/${Date.now()}-${file.name}`, file, {
      access: "public",
      onUploadProgress(event) {
        onProgress?.(55 + Math.min(45, event.percentage * 0.45), `Uploading smart batch · ${Math.round(event.percentage)}%`);
      },
    });

    onProgress?.(100, "Smart batch ready for V-Editor.");
    return {
      imageUrl: uploaded.url,
      crops: layout.panels.map((panel) => ({
        x: panel.left / layout.width,
        y: panel.top / layout.height,
        width: panel.width / layout.width,
        height: panel.height / layout.height,
      })),
    };
  } finally {
    a.close();
    b.close();
  }
}

async function splitAndPersist(outputUrl: string, crops: NormalizedCrop[], pairKey: string, originalFetch: typeof window.fetch) {
  const bitmap = await fetchBitmap(outputUrl, originalFetch);
  try {
    return await Promise.all(crops.map(async (crop, panelIndex) => {
      const sx = Math.max(0, Math.min(bitmap.width - 1, Math.round(crop.x * bitmap.width)));
      const sy = Math.max(0, Math.min(bitmap.height - 1, Math.round(crop.y * bitmap.height)));
      const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(crop.width * bitmap.width)));
      const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(crop.height * bitmap.height)));
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas is not available in this browser.");
      context.imageSmoothingEnabled = false;
      context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
      const blob = await canvasBlob(canvas, "image/png");
      const file = new File([blob], `pixora-${pairKey}-${panelIndex + 1}.png`, { type: "image/png" });
      const uploaded = await uploadResult(`pixora-results/batch/${pairKey}-${panelIndex + 1}.png`, file);
      return uploaded.url;
    }));
  } finally {
    bitmap.close();
  }
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

export default function BatchPairBridge() {
  useEffect(() => {
    const originalFetch = window.fetch.bind(window);
    const syntheticTasks = restoreSyntheticTasks();
    const pendingSyntheticTasks = new Map<string, PendingSyntheticTask>();
    persistSyntheticTasks(syntheticTasks);
    const splitPromises = new Map<string, Promise<string[]>>();
    const pollCache = new Map<string, { at: number; data: TaskPoll; ok: boolean; status: number }>();
    const splitWaiters: Array<() => void> = [];
    const splitLimit = window.matchMedia("(max-width: 800px)").matches ? 1 : 2;
    let activeSplits = 0;

    const withSplitSlot = async <T,>(worker: () => Promise<T>) => {
      if (activeSplits >= splitLimit) await new Promise<void>((resolve) => splitWaiters.push(resolve));
      activeSplits += 1;
      try { return await worker(); }
      finally {
        activeSplits -= 1;
        splitWaiters.shift()?.();
      }
    };

    const pollRealTask = async (realTaskId: string) => {
      const cached = pollCache.get(realTaskId);
      if (cached && (cached.data.status === "succeeded" || cached.data.status === "failed" || Date.now() - cached.at < 650)) return cached;
      const response = await originalFetch(`/api/task?id=${encodeURIComponent(realTaskId)}`, { cache: "no-store" });
      const data = await response.json() as TaskPoll;
      const value = { at: Date.now(), data, ok: response.ok, status: response.status };
      pollCache.set(realTaskId, value);
      return value;
    };

    const patchedFetch: typeof window.fetch = async (input, init) => {
      const url = new URL(requestUrl(input), window.location.href);

      if (url.origin === window.location.origin && url.pathname === "/api/generate-batch" && requestMethod(input, init) === "POST" && typeof init?.body === "string") {
        let payload: BatchPayload;
        try { payload = JSON.parse(init.body) as BatchPayload; }
        catch { return originalFetch(input, init); }

        const imageUrls = Array.isArray(payload.imageUrls) ? payload.imageUrls : [];
        if (imageUrls.length < 2 || !payload.prompt?.trim()) return originalFetch(input, init);

        // Resolve the original local object URLs from the visible batch cards. This means the
        // combine step does not download the just-uploaded originals back from the network.
        const localPreviews = currentLocalPreviewUrls(imageUrls.length);
        const pairStarts = Array.from({ length: Math.ceil(imageUrls.length / 2) }, (_, index) => index * 2);
        const groupProgress = new Array(pairStarts.length).fill(0);
        const reportGroupProgress = (groupIndex: number, percent: number, detail: string) => {
          groupProgress[groupIndex] = Math.max(groupProgress[groupIndex], Math.max(0, Math.min(100, percent)));
          const overall = groupProgress.reduce((sum, value) => sum + value, 0) / Math.max(1, groupProgress.length);
          emitPairProgress({ percent: overall, detail });
        };

        emitPairProgress({ percent: 1, detail: "Live pipeline started — preparing the first pair now." });

        const pipelineGroups = pairStarts.map((start, groupIndex) => {
          const originalIndexes = start + 1 < imageUrls.length ? [start, start + 1] : [start];
          const taskIds = originalIndexes.map(() => `${PAIR_PREFIX}${crypto.randomUUID().replace(/-/g, "")}`);
          taskIds.forEach((taskId) => pendingSyntheticTasks.set(taskId, {}));
          return { start, groupIndex, originalIndexes, taskIds };
        });
        const expandedTasks: BatchTask[] = pipelineGroups.flatMap((group) => group.originalIndexes.map((index, panelIndex) => ({
          index,
          taskId: group.taskIds[panelIndex],
        })));

        // Return task handles immediately. Each worker prepares one pair and submits it to
        // V-Editor without waiting for the remaining pairs, so generation, splitting and UI
        // delivery overlap with preparation of the rest of the batch.
        void mapLimit(pipelineGroups, 2, async (pipelineGroup) => {
          const { start, groupIndex, originalIndexes, taskIds } = pipelineGroup;
          let group: PreparedGroup;
          try {
            if (originalIndexes.length === 1) {
              group = {
                originalIndexes,
                imageUrl: imageUrls[start],
                crops: [],
                aspectRatio: payload.aspectRatio || "default",
                resultResolution: 0,
                prompt: payload.prompt!.trim(),
              };
              reportGroupProgress(groupIndex, 55, `Image ${start + 1} ready for V-Editor.`);
            } else {
              const composite = await makeComposite(
                localPreviews[start] || imageUrls[start],
                localPreviews[start + 1] || imageUrls[start + 1],
                originalFetch,
                (percent, detail) => reportGroupProgress(groupIndex, percent * 0.55, detail),
              );
              group = {
                originalIndexes,
                imageUrl: composite.imageUrl,
                crops: composite.crops,
                aspectRatio: "default",
                resultResolution: 1,
                prompt: buildPairPrompt(payload.prompt!),
              };
            }

            reportGroupProgress(groupIndex, 65, `Pair ${groupIndex + 1} prepared · sending to V-Editor…`);
            const response = await originalFetch(input, {
              ...init,
              body: JSON.stringify({
                imageUrls: [group.imageUrl],
                prompt: payload.prompt,
                aspectRatio: payload.aspectRatio,
                prompts: [group.prompt],
                aspectRatios: [group.aspectRatio],
                resultResolutions: [group.resultResolution],
              }),
            });
            const data = await response.json() as { tasks?: BatchTask[]; error?: string };
            const realTask = data.tasks?.[0];
            if (!response.ok || !realTask?.taskId) throw new Error(realTask?.error || data.error || "Could not start this pair.");

            const pairKey = crypto.randomUUID();
            taskIds.forEach((syntheticId, panelIndex) => {
              const entry: SyntheticTask = {
                realTaskId: realTask.taskId!,
                crop: group.crops[panelIndex] || { x: 0, y: 0, width: 1, height: 1 },
                panelIndex,
                pairKey,
                createdAt: Date.now(),
              };
              syntheticTasks.set(syntheticId, entry);
              const pending = pendingSyntheticTasks.get(syntheticId);
              if (pending) pending.entry = entry;
            });
            persistSyntheticTasks(syntheticTasks);
            persistBridgeBatch(imageUrls, payload, expandedTasks, pipelineGroups.length);
            reportGroupProgress(groupIndex, 100, `Pair ${groupIndex + 1} is generating · preparing the next pair in parallel.`);
          } catch (error) {
            const detail = error instanceof Error ? error.message : "Could not prepare or start this pair.";
            taskIds.forEach((syntheticId) => {
              const pending = pendingSyntheticTasks.get(syntheticId);
              if (pending) pending.error = detail;
            });
            reportGroupProgress(groupIndex, 100, `Pair ${groupIndex + 1} failed to start; later pairs will continue.`);
          }
        }).catch(() => undefined);

        expandedTasks.sort((a, b) => a.index - b.index);
        persistBridgeBatch(imageUrls, payload, expandedTasks, pipelineGroups.length);
        return new Response(JSON.stringify({
          tasks: expandedTasks,
          sourceImageCount: imageUrls.length,
          vmodelRequestCount: pipelineGroups.length,
        }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      if (url.origin === window.location.origin && url.pathname === "/api/task" && requestMethod(input, init) === "GET") {
        const syntheticId = url.searchParams.get("id") || "";
        const pending = pendingSyntheticTasks.get(syntheticId);
        const entry = syntheticTasks.get(syntheticId) || pending?.entry;
        if (!entry && pending?.error) {
          return new Response(JSON.stringify({ status: "failed", error: pending.error }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
        }
        if (!entry && pending) {
          return new Response(JSON.stringify({ status: "preparing" }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
        }
        if (!entry) return originalFetch(input, init);

        const polled = await pollRealTask(entry.realTaskId);
        if (!polled.ok) {
          return new Response(JSON.stringify(polled.data), { status: polled.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
        }
        if (polled.data.status !== "succeeded" || !polled.data.output?.[0]) {
          return new Response(JSON.stringify(polled.data), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
        }

        let splitPromise = splitPromises.get(entry.realTaskId);
        if (!splitPromise) {
          const siblingEntries = Array.from(syntheticTasks.values()).filter((item) => item.realTaskId === entry.realTaskId).sort((a, b) => a.panelIndex - b.panelIndex);
          const crops = siblingEntries.map((item) => item.crop);
          splitPromise = withSplitSlot(() => splitAndPersist(polled.data.output![0], crops, entry.pairKey, originalFetch));
          splitPromises.set(entry.realTaskId, splitPromise);
        }

        try {
          const outputs = await splitPromise;
          const output = outputs[entry.panelIndex];
          if (!output) throw new Error("The paired result could not be separated.");
          return new Response(JSON.stringify({ ...polled.data, output: [output] }), {
            status: 200,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            status: "failed",
            error: error instanceof Error ? error.message : "Could not separate the paired result.",
          }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
        }
      }

      return originalFetch(input, init);
    };

    window.fetch = patchedFetch;

    const updateBatchCopy = () => {
      document.querySelectorAll<HTMLElement>(".fineprint").forEach((node) => {
        if (node.textContent?.includes("Each image is a separate V-Editor request") || node.textContent?.includes("Smart pairing uses") || node.textContent?.includes("Lossless smart pairing uses")) {
          node.textContent = "No-crop local pairing uses 1 V-Editor request for every 2 batch images · original aspect ratios are preserved.";
        }
      });
      document.querySelectorAll<HTMLElement>(".privacy").forEach((node) => {
        if (node.textContent?.includes("One prompt, separate generations") || node.textContent?.includes("One prompt, smart paired processing") || node.textContent?.includes("One prompt, lossless paired processing")) {
          node.textContent = "◆ One prompt, local lossless paired processing";
        }
      });
    };
    updateBatchCopy();
    const observer = new MutationObserver(updateBatchCopy);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      persistSyntheticTasks(syntheticTasks);
      if (window.fetch === patchedFetch) window.fetch = originalFetch;
    };
  }, []);

  return null;
}
