"use client";

import { useEffect } from "react";
import { upload, uploadResult } from "../lib/imagekit-upload-client";

type NormalizedCrop = { x: number; y: number; width: number; height: number };
type Panel = { left: number; top: number; width: number; height: number };
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
  resultResolution: 0 | 1;
  prompt: string;
  error?: string;
};
type SyntheticTask = {
  realTaskId: string;
  crop: NormalizedCrop;
  panelIndex: number;
  pairKey: string;
};
type TaskPoll = { status?: string; output?: string[]; error?: string };

const PAIR_PREFIX = "pxpair_";
const SEAM = 8;
const TARGET_SIDE = 1400;
const MAX_CANVAS_SIDE = 3072;
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

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not encode the batch image.")), type, quality);
  });
}

async function fetchBitmap(url: string, originalFetch: typeof window.fetch) {
  const params = new URLSearchParams({ url, filename: "pixora-pair-source", disposition: "inline" });
  const response = await originalFetch(`/api/download?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not read a batch source (${response.status}).`);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("A batch source did not return an image.");
  return createImageBitmap(blob);
}

function scaleLayout(width: number, height: number, panels: Panel[]) {
  const scale = Math.min(1, MAX_CANVAS_SIDE / Math.max(width, height));
  if (scale === 1) return { width, height, panels };
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

function naturalLayout(a: ImageBitmap, b: ImageBitmap) {
  const aRatio = a.width / a.height;
  const bRatio = b.width / b.height;

  // Side-by-side candidate: scale both proportionally to one shared height.
  // We never enlarge a source just to make the collage, which avoids needless interpolation.
  const sharedHeight = Math.max(1, Math.min(TARGET_SIDE, a.height, b.height));
  const horizontalAWidth = Math.max(1, Math.round(sharedHeight * aRatio));
  const horizontalBWidth = Math.max(1, Math.round(sharedHeight * bRatio));
  const horizontalWidth = horizontalAWidth + SEAM + horizontalBWidth;
  const horizontalScore = Math.abs(Math.log(horizontalWidth / sharedHeight));

  // Top/bottom candidate: scale both proportionally to one shared width.
  const sharedWidth = Math.max(1, Math.min(TARGET_SIDE, a.width, b.width));
  const verticalAHeight = Math.max(1, Math.round(sharedWidth / aRatio));
  const verticalBHeight = Math.max(1, Math.round(sharedWidth / bRatio));
  const verticalHeight = verticalAHeight + SEAM + verticalBHeight;
  const verticalScore = Math.abs(Math.log(sharedWidth / verticalHeight));

  if (horizontalScore <= verticalScore) {
    return scaleLayout(horizontalWidth, sharedHeight, [
      { left: 0, top: 0, width: horizontalAWidth, height: sharedHeight },
      { left: horizontalAWidth + SEAM, top: 0, width: horizontalBWidth, height: sharedHeight },
    ]);
  }

  return scaleLayout(sharedWidth, verticalHeight, [
    { left: 0, top: 0, width: sharedWidth, height: verticalAHeight },
    { left: 0, top: verticalAHeight + SEAM, width: sharedWidth, height: verticalBHeight },
  ]);
}

function requestedRatioLayout(targetRatio: number) {
  // When the user explicitly chooses an output ratio, each panel must have that ratio so
  // the final split images keep the requested shape. Sources are contained without cropping.
  if (targetRatio <= 1) {
    const height = TARGET_SIDE;
    const width = Math.max(1, Math.round(height * targetRatio));
    return scaleLayout(width * 2 + SEAM, height, [
      { left: 0, top: 0, width, height },
      { left: width + SEAM, top: 0, width, height },
    ]);
  }

  const width = TARGET_SIDE;
  const height = Math.max(1, Math.round(width / targetRatio));
  return scaleLayout(width, height * 2 + SEAM, [
    { left: 0, top: 0, width, height },
    { left: 0, top: height + SEAM, width, height },
  ]);
}

function choosePanels(a: ImageBitmap, b: ImageBitmap, targetRatio: number | null) {
  return targetRatio ? requestedRatioLayout(targetRatio) : naturalLayout(a, b);
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

async function makeComposite(urlA: string, urlB: string, ratio: string, originalFetch: typeof window.fetch) {
  const [a, b] = await Promise.all([fetchBitmap(urlA, originalFetch), fetchBitmap(urlB, originalFetch)]);
  try {
    const layout = choosePanels(a, b, parseRatio(ratio));
    const canvas = document.createElement("canvas");
    canvas.width = layout.width;
    canvas.height = layout.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not available in this browser.");

    // This is intentionally only normal canvas compositing: no face detection, enhancement,
    // alignment, segmentation, AI preprocessing, crop-normalisation, or smart retouching.
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    drawContained(context, a, layout.panels[0]);
    drawContained(context, b, layout.panels[1]);

    // Keep only a very small neutral seam so V-Editor can distinguish the two photos without
    // adding a heavy divider that could become part of the generated image.
    const first = layout.panels[0];
    const second = layout.panels[1];
    context.fillStyle = "#ffffff";
    if (first.top === second.top) {
      context.fillRect(first.left + first.width, 0, Math.max(1, second.left - first.left - first.width), canvas.height);
    } else {
      context.fillRect(0, first.top + first.height, canvas.width, Math.max(1, second.top - first.top - first.height));
    }

    // PNG avoids the extra JPEG compression pass that previously happened before V-Editor.
    const blob = await canvasBlob(canvas, "image/png");
    const file = new File([blob], `pixora-pair-${crypto.randomUUID()}.png`, { type: "image/png" });
    const uploaded = await upload(`pixora-inputs/pairs/${Date.now()}-${file.name}`, file, { access: "public" });
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
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is not available in this browser.");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
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
    const syntheticTasks = new Map<string, SyntheticTask>();
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

        const pairStarts = Array.from({ length: Math.ceil(imageUrls.length / 2) }, (_, index) => index * 2);
        const groups = await mapLimit(pairStarts, 3, async (start): Promise<PreparedGroup> => {
          const second = start + 1;
          if (second >= imageUrls.length) {
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
            const composite = await makeComposite(imageUrls[start], imageUrls[second], payload.aspectRatio || "default", originalFetch);
            return {
              originalIndexes: [start, second],
              imageUrl: composite.imageUrl,
              crops: composite.crops,
              aspectRatio: "default",
              resultResolution: 1,
              prompt: buildPairPrompt(payload.prompt!),
            };
          } catch (error) {
            return {
              originalIndexes: [start, second],
              crops: [],
              aspectRatio: "default",
              resultResolution: 1,
              prompt: payload.prompt!.trim(),
              error: error instanceof Error ? error.message : "Could not prepare this image pair.",
            };
          }
        });

        const submittedGroups = groups.filter((group) => group.imageUrl);
        const expandedTasks: BatchTask[] = groups.flatMap((group) => group.error
          ? group.originalIndexes.map((index) => ({ index, error: group.error }))
          : []);

        if (!submittedGroups.length) {
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
            });
            expandedTasks.push({ index: originalIndex, taskId: syntheticId });
          });
        }

        expandedTasks.sort((a, b) => a.index - b.index);
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
        if (node.textContent?.includes("Each image is a separate V-Editor request") || node.textContent?.includes("Smart pairing uses")) {
          node.textContent = "Lossless smart pairing uses 1 V-Editor request for every 2 batch images · 50 images = 25 API requests.";
        }
      });
      document.querySelectorAll<HTMLElement>(".privacy").forEach((node) => {
        if (node.textContent?.includes("One prompt, separate generations") || node.textContent?.includes("One prompt, smart paired processing")) node.textContent = "◆ One prompt, lossless paired processing";
      });
    };
    updateBatchCopy();
    const observer = new MutationObserver(updateBatchCopy);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (window.fetch === patchedFetch) window.fetch = originalFetch;
    };
  }, []);

  return null;
}
