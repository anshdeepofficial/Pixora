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
// 3072 is large enough to keep two typical 1080p sources at or near their native pixel size,
// while keeping PNG encoding/upload memory reasonable on mobile browsers.
const MAX_CANVAS_SIDE = 3072;
const MAX_CANVAS_PIXELS = 8_500_000;
const FACE_LOCK_MARKER = "Preserve the exact facial identity";
const POSE_LOCK_MARKER = "Preserve the exact body pose";
const BATCH_DIRECTIVE = "BATCH COLLAGE: The input is a simple two-panel collage made from two separate source photos. The user's instruction above is the primary edit request. Treat each panel as an independent image and apply that same requested edit separately to each panel. Never merge, blend, swap, copy, or transfer faces, identities, hair, bodies, clothes, poses, backgrounds, or objects between panels. Keep each subject in its own panel. Do not invent a third person. Keep the panel boundary stable. If neutral padding exists only to preserve a requested output ratio, extend that panel's own photo naturally into its padding without borrowing content from the other panel.";
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

function parseRatio(value?: string) {
  if (!value || value === "default") return null;
  const [w, h] = value.split(":").map(Number);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w / h : null;
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

function panelSizeForSource(bitmap: ImageBitmap, targetRatio: number | null): PanelSize {
  if (!targetRatio) return { width: bitmap.width, height: bitmap.height };

  // Build the smallest requested-ratio frame that contains the full source at native size.
  // This creates padding only when the user explicitly asks for a different output ratio.
  const sourceRatio = bitmap.width / bitmap.height;
  if (sourceRatio > targetRatio) {
    return { width: bitmap.width, height: Math.max(bitmap.height, Math.ceil(bitmap.width / targetRatio)) };
  }
  return { width: Math.max(bitmap.width, Math.ceil(bitmap.height * targetRatio)), height: bitmap.height };
}

function choosePanels(a: ImageBitmap, b: ImageBitmap, targetRatio: number | null) {
  return chooseCompactLayout(panelSizeForSource(a, targetRatio), panelSizeForSource(b, targetRatio));
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
  ratio: string,
  originalFetch: typeof window.fetch,
  onProgress?: (percent: number, detail: string) => void,
) {
  onProgress?.(5, "Reading the two original images locally…");
  const [a, b] = await Promise.all([fetchBitmap(sourceA, originalFetch), fetchBitmap(sourceB, originalFetch)]);
  try {
    onProgress?.(20, "Choosing a no-crop layout from the original dimensions…");
    const layout = choosePanels(a, b, parseRatio(ratio));
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

    onProgress?.(42, `Building lossless ${canvas.width}×${canvas.height} PNG collage…`);
    const blob = await canvasBlob(canvas, "image/png");
    const file = new File([blob], `pixora-pair-${crypto.randomUUID()}.png`, { type: "image/png" });

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
    persistSyntheticTasks(syntheticTasks);
    const splitPromises = new Map<string, Promise<string[]>>();
    const pollCache = new Map<string, { at: number; data: TaskPoll; ok: boolean; status: number }>();

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

        emitPairProgress({ percent: 1, detail: "Using original local images — no re-download and no AI preprocessing." });

        const groups = await mapLimit(pairStarts, 2, async (start, groupIndex): Promise<PreparedGroup> => {
          const second = start + 1;
          if (second >= imageUrls.length) {
            reportGroupProgress(groupIndex, 100, "Odd final image stays as a normal single V-Editor request.");
            return {
              originalIndexes: [start],
              imageUrl: imageUrls[start],
              crops: [],
              aspectRatio: payload.aspectRatio || "default",
              resultResolution: 0,
              prompt: payload.prompt!.trim(),
            };
          }

          try {
            const sourceA = localPreviews[start] || imageUrls[start];
            const sourceB = localPreviews[second] || imageUrls[second];
            const composite = await makeComposite(
              sourceA,
              sourceB,
              payload.aspectRatio || "default",
              originalFetch,
              (percent, detail) => reportGroupProgress(groupIndex, percent, detail),
            );
            return {
              originalIndexes: [start, second],
              imageUrl: composite.imageUrl,
              crops: composite.crops,
              aspectRatio: "default",
              // Highest V-Editor result resolution is important because the single returned canvas
              // is split into two final images afterwards.
              resultResolution: 2,
              prompt: buildPairPrompt(payload.prompt!),
            };
          } catch (error) {
            reportGroupProgress(groupIndex, 100, "A smart batch could not be prepared.");
            return {
              originalIndexes: [start, second],
              crops: [],
              aspectRatio: "default",
              resultResolution: 2,
              prompt: payload.prompt!.trim(),
              error: error instanceof Error ? error.message : "Could not prepare this image pair.",
            };
          }
        });

        emitPairProgress({ percent: 100, detail: "Smart batches uploaded. Starting V-Editor now…" });

        const submittedGroups = groups.filter((group) => group.imageUrl);
        const expandedTasks: BatchTask[] = groups.flatMap((group) => group.error
          ? group.originalIndexes.map((index) => ({ index, error: group.error }))
          : []);

        if (!submittedGroups.length) {
          expandedTasks.sort((a, b) => a.index - b.index);
          persistBridgeBatch(imageUrls, payload, expandedTasks, 0);
          return new Response(JSON.stringify({ tasks: expandedTasks, error: "Could not prepare any image pair." }), {
            status: 200,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
          });
        }

        const transformedBody = JSON.stringify({
          imageUrls: submittedGroups.map((group) => group.imageUrl),
          prompt: payload.prompt,
          aspectRatio: payload.aspectRatio,
          prompts: submittedGroups.map((group) => group.prompt),
          aspectRatios: submittedGroups.map((group) => group.aspectRatio),
          resultResolutions: submittedGroups.map((group) => group.resultResolution),
        });
        const serverResponse = await originalFetch(input, { ...init, body: transformedBody });
        const serverData = await serverResponse.json() as { tasks?: BatchTask[]; error?: string };

        for (const task of serverData.tasks || []) {
          const group = submittedGroups[task.index];
          if (!group) continue;
          if (!task.taskId) {
            expandedTasks.push(...group.originalIndexes.map((index) => ({ index, error: task.error || "Could not start this pair." })));
            continue;
          }
          if (group.originalIndexes.length === 1) {
            expandedTasks.push({ index: group.originalIndexes[0], taskId: task.taskId });
            continue;
          }
          const pairKey = crypto.randomUUID();
          group.originalIndexes.forEach((originalIndex, panelIndex) => {
            const syntheticId = `${PAIR_PREFIX}${crypto.randomUUID().replace(/-/g, "")}`;
            syntheticTasks.set(syntheticId, {
              realTaskId: task.taskId!,
              crop: group.crops[panelIndex],
              panelIndex,
              pairKey,
              createdAt: Date.now(),
            });
            expandedTasks.push({ index: originalIndex, taskId: syntheticId });
          });
        }

        persistSyntheticTasks(syntheticTasks);
        expandedTasks.sort((a, b) => a.index - b.index);
        persistBridgeBatch(imageUrls, payload, expandedTasks, submittedGroups.length);
        return new Response(JSON.stringify({
          ...serverData,
          tasks: expandedTasks,
          sourceImageCount: imageUrls.length,
          vmodelRequestCount: submittedGroups.length,
        }), {
          status: serverResponse.ok || expandedTasks.length ? 200 : serverResponse.status,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      if (url.origin === window.location.origin && url.pathname === "/api/task" && requestMethod(input, init) === "GET") {
        const syntheticId = url.searchParams.get("id") || "";
        const entry = syntheticTasks.get(syntheticId);
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
          splitPromise = splitAndPersist(polled.data.output[0], crops, entry.pairKey, originalFetch);
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
          node.textContent = "Lossless local pairing uses 1 V-Editor request for every 2 batch images · paired outputs use maximum V-Editor resolution.";
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
