"use client";

import { useEffect } from "react";
import { upload, uploadResult } from "../lib/imagekit-upload-client";

type NormalizedCrop = { x: number; y: number; width: number; height: number };
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
const GUTTER = 36;
const TARGET_SIDE = 1024;
const MAX_CANVAS_SIDE = 3072;
const BATCH_DIRECTIVE = "BATCH GRID: Treat the two image panels as fully independent photos. Apply the edit separately to both. Never merge, mix, copy, or move content between panels. Keep the divider and panel boundaries fixed. If a panel has padding only to preserve the full source at the requested ratio, extend that same photo naturally into the padding.";

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

function scaleLayout(width: number, height: number, panels: Array<{ left: number; top: number; width: number; height: number }>) {
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

function choosePanels(aRatio: number, bRatio: number, targetRatio: number | null) {
  if (targetRatio) {
    if (targetRatio <= 1) {
      const height = TARGET_SIDE;
      const width = Math.max(1, Math.round(height * targetRatio));
      return scaleLayout(width * 2 + GUTTER, height, [
        { left: 0, top: 0, width, height },
        { left: width + GUTTER, top: 0, width, height },
      ]);
    }
    const width = TARGET_SIDE;
    const height = Math.max(1, Math.round(width / targetRatio));
    return scaleLayout(width, height * 2 + GUTTER, [
      { left: 0, top: 0, width, height },
      { left: 0, top: height + GUTTER, width, height },
    ]);
  }

  const horizontalHeight = TARGET_SIDE;
  const horizontalA = Math.max(1, Math.round(horizontalHeight * aRatio));
  const horizontalB = Math.max(1, Math.round(horizontalHeight * bRatio));
  const horizontalWidth = horizontalA + GUTTER + horizontalB;
  const horizontalScore = Math.abs(Math.log(horizontalWidth / horizontalHeight));

  const verticalWidth = TARGET_SIDE;
  const verticalA = Math.max(1, Math.round(verticalWidth / aRatio));
  const verticalB = Math.max(1, Math.round(verticalWidth / bRatio));
  const verticalHeight = verticalA + GUTTER + verticalB;
  const verticalScore = Math.abs(Math.log(verticalWidth / verticalHeight));

  if (horizontalScore <= verticalScore) {
    return scaleLayout(horizontalWidth, horizontalHeight, [
      { left: 0, top: 0, width: horizontalA, height: horizontalHeight },
      { left: horizontalA + GUTTER, top: 0, width: horizontalB, height: horizontalHeight },
    ]);
  }
  return scaleLayout(verticalWidth, verticalHeight, [
    { left: 0, top: 0, width: verticalWidth, height: verticalA },
    { left: 0, top: verticalA + GUTTER, width: verticalWidth, height: verticalB },
  ]);
}

function drawContained(context: CanvasRenderingContext2D, bitmap: ImageBitmap, panel: { left: number; top: number; width: number; height: number }) {
  context.fillStyle = "#f4f4f2";
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

async function makeComposite(urlA: string, urlB: string, ratio: string, originalFetch: typeof window.fetch) {
  const [a, b] = await Promise.all([fetchBitmap(urlA, originalFetch), fetchBitmap(urlB, originalFetch)]);
  try {
    const layout = choosePanels(a.width / a.height, b.width / b.height, parseRatio(ratio));
    const canvas = document.createElement("canvas");
    canvas.width = layout.width;
    canvas.height = layout.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not available in this browser.");

    context.fillStyle = "#d9d9d5";
    context.fillRect(0, 0, canvas.width, canvas.height);
    drawContained(context, a, layout.panels[0]);
    drawContained(context, b, layout.panels[1]);

    const first = layout.panels[0];
    const second = layout.panels[1];
    context.fillStyle = "#111111";
    if (first.top === second.top) {
      const x = first.left + first.width + Math.floor((second.left - first.left - first.width) / 2);
      context.fillRect(Math.max(0, x - 2), 0, 4, canvas.height);
    } else {
      const y = first.top + first.height + Math.floor((second.top - first.top - first.height) / 2);
      context.fillRect(0, Math.max(0, y - 2), canvas.width, 4);
    }

    const blob = await canvasBlob(canvas, "image/jpeg", 0.94);
    const file = new File([blob], `pixora-pair-${crypto.randomUUID()}.jpg`, { type: "image/jpeg" });
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
              prompt: `${BATCH_DIRECTIVE}\n\n${payload.prompt!.trim()}`,
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
        if (node.textContent?.includes("Each image is a separate V-Editor request")) {
          node.textContent = "Smart pairing uses 1 V-Editor request for every 2 batch images · 50 images = 25 API requests.";
        }
      });
      document.querySelectorAll<HTMLElement>(".privacy").forEach((node) => {
        if (node.textContent?.includes("One prompt, separate generations")) node.textContent = "◆ One prompt, smart paired processing";
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
