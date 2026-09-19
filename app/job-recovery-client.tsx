// @ts-nocheck
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { upload } from "../lib/imagekit-upload-client";

// v4 intentionally retires the oversized legacy failure panel saved by older builds.
const ACTIVE_JOB_KEY = "pixora-active-job-v4";
const LEGACY_ACTIVE_JOB_KEY = "pixora-active-job-v3";
const BRIDGE_BATCH_KEY = "pixora-bridge-last-batch-v1";
const RECOVERY_DB = "pixora-job-recovery";
const RECOVERY_STORE = "files";
const MAX_JOB_AGE = 24 * 60 * 60 * 1000;
const POLL_MS = 1200;

function bootId() {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random()}`; }
}

function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}

function writeJob(job) {
  try {
    if (job) localStorage.setItem(ACTIVE_JOB_KEY, JSON.stringify(job));
    else localStorage.removeItem(ACTIVE_JOB_KEY);
  } catch {}
}

function freshJob(job) {
  return Boolean(job && typeof job.createdAt === "number" && Date.now() - job.createdAt < MAX_JOB_AGE);
}

function taskDone(task) {
  return task?.status === "done" || task?.status === "failed";
}

function mergeHistory(output, prompt) {
  if (!output) return;
  try {
    const current = JSON.parse(localStorage.getItem("pixora-history") || "[]");
    if (current.some((item) => item?.url === output)) return;
    const next = [{ url: output, prompt: prompt || "Recovered generation", createdAt: new Date().toISOString() }, ...current];
    localStorage.setItem("pixora-history", JSON.stringify(next));
  } catch {}
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input?.url || "";
}

function requestMethod(input, init) {
  if (init?.method) return String(init.method).toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function bodyJson(init) {
  if (typeof init?.body !== "string") return null;
  try { return JSON.parse(init.body); } catch { return null; }
}

function openRecoveryDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("IndexedDB unavailable"));
    const request = indexedDB.open(RECOVERY_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECOVERY_STORE)) db.createObjectStore(RECOVERY_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open recovery storage"));
  });
}

async function storeRecoveryFiles(jobId, files) {
  if (!files?.length) return;
  const db = await openRecoveryDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(RECOVERY_STORE, "readwrite");
    const store = tx.objectStore(RECOVERY_STORE);
    store.put(files, jobId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Could not save recovery files"));
  });
  db.close();
}

async function readRecoveryFiles(jobId) {
  try {
    const db = await openRecoveryDb();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(RECOVERY_STORE, "readonly");
      const request = tx.objectStore(RECOVERY_STORE).get(jobId);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

async function clearRecoveryFiles(jobId) {
  if (!jobId) return;
  try {
    const db = await openRecoveryDb();
    await new Promise((resolve) => {
      const tx = db.transaction(RECOVERY_STORE, "readwrite");
      tx.objectStore(RECOVERY_STORE).delete(jobId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {}
}

function ratioFromControls(container) {
  const active = container?.querySelector?.(".ratios button.active");
  const text = (active?.textContent || "").trim();
  return !text || /^auto$/i.test(text) ? "default" : text;
}

function applyPreservation(prompt, face, pose, referenceMode = false) {
  const constraints = [];
  if (face) constraints.push("Preserve the exact facial identity of every person from the main/input image: keep facial structure, features, skin tone, age, hairstyle, and recognizable identity unchanged. Do not replace, redesign, beautify, or morph the face.");
  if (pose) constraints.push("Preserve the exact body pose, limb positions, camera angle, crop, framing, and composition of the main/input image. Do not change the pose unless the requested edit makes it physically impossible.");
  if (referenceMode && constraints.length) constraints.push("Use the reference image only as visual guidance; do not copy the reference person's identity or pose over the main subject when those locks are enabled.");
  return constraints.length ? `${String(prompt || "").trim()}\n\nImportant preservation constraints: ${constraints.join(" ")}` : String(prompt || "").trim();
}

function previewSources(container) {
  return Array.from(container?.querySelectorAll?.(".batchCard .batchThumb img") || [])
    .map((img) => img.src)
    .filter(Boolean);
}

async function blobsFromSources(sources) {
  const blobs = [];
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    try {
      const response = await fetch(source);
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) continue;
      blobs.push({ blob, name: `recovery-${index + 1}.${blob.type.includes("png") ? "png" : blob.type.includes("webp") ? "webp" : "jpg"}`, type: blob.type });
    } catch {}
  }
  return blobs;
}

function arraysEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);
}

function bridgeTasksFor(job) {
  const bridge = readJson(BRIDGE_BATCH_KEY);
  if (!bridge || Date.now() - Number(bridge.at || 0) > 10 * 60 * 1000) return null;
  if (!arraysEqual(bridge.sourceImageUrls, job?.sourceUrls)) return null;
  if (!Array.isArray(bridge.tasks)) return null;
  return bridge.tasks.map((task) => ({
    index: task.index,
    taskId: task.taskId,
    status: task.taskId ? "queued" : "failed",
    error: task.error,
  }));
}

function failedGroups(job) {
  if (!job) return [];
  if (job.kind !== "batch") {
    return job.tasks?.some((task) => task.status === "failed") ? [[0]] : [];
  }
  const tasks = Array.isArray(job.tasks) ? job.tasks : [];
  const count = Number(job.sourceCount || job.sourceUrls?.length || 0);
  const groups = [];
  for (let start = 0; start < count; start += 2) {
    const indexes = start + 1 < count ? [start, start + 1] : [start];
    const hasFailure = indexes.some((index) => tasks.find((task) => task.index === index)?.status === "failed");
    if (hasFailure) groups.push(indexes);
  }
  return groups;
}

function syncRecoveredInline(job) {
  if (!job || job.kind !== "batch" || typeof document === "undefined") return;
  const active = ["submitting", "processing"].includes(job.phase);
  if (!active) return;
  const total = Number(job.sourceCount || job.sourceUrls?.length || 0);
  const done = (job.tasks || []).filter((task) => task.status === "done").length;
  const failed = (job.tasks || []).filter((task) => task.status === "failed").length;
  const button = document.querySelector(".batchWorkspace .controls .generate");
  const progress = document.querySelector(".batchWorkspace .controls .progressBox");
  const labelText = job.phase === "submitting"
    ? "Recovered after refresh · rebuilding/submitting pending batch"
    : `Recovered after refresh · V-Editor running · ${done}/${total} ready${failed ? ` · ${failed} failed` : ""}`;
  if (button) {
    button.replaceChildren();
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    button.append(spinner, document.createTextNode(` ${labelText}`));
    button.setAttribute("disabled", "true");
  }
  if (progress) {
    const label = progress.querySelector(".progressTop span");
    const value = progress.querySelector(".progressTop strong");
    const fill = progress.querySelector(".progressTrack i");
    const pct = total ? ((done + failed) / total) * 100 : 0;
    if (label) label.textContent = labelText;
    if (value) value.textContent = `${done}/${total}`;
    if (fill) fill.style.width = `${pct}%`;
  }
}

export default function JobRecoveryClient() {
  const currentBoot = useRef(bootId());
  const networkFetch = useRef(null);
  const jobRef = useRef(null);
  const pollingRef = useRef(false);
  const resumeAttempted = useRef(false);
  const [job, setJob] = useState(null);
  const [recovered, setRecovered] = useState(false);
  const [message, setMessage] = useState("");

  const commit = (next) => {
    if (!next) {
      jobRef.current = null;
      setJob(null);
      writeJob(null);
      return;
    }
    const stamped = { ...next, updatedAt: Date.now() };
    jobRef.current = stamped;
    setJob(stamped);
    writeJob(stamped);
    syncRecoveredInline(stamped);
  };

  const markTaskFromPoll = (taskId, data, ok = true) => {
    const current = jobRef.current;
    if (!current || !Array.isArray(current.tasks)) return;
    const position = current.tasks.findIndex((task) => task.taskId === taskId);
    if (position < 0) return;
    const tasks = current.tasks.map((task) => ({ ...task }));
    const target = tasks[position];
    if (!ok) {
      target.status = "failed";
      target.error = data?.error || "Could not check task";
    } else if (data?.status === "failed") {
      target.status = "failed";
      target.error = data?.error || "Generation failed";
    } else if (data?.status === "succeeded" && data?.output?.[0]) {
      target.status = "done";
      target.output = data.output[0];
      target.error = undefined;
      if (current.bootId !== currentBoot.current || current.managedByRecovery) mergeHistory(target.output, current.prompt);
    } else {
      target.status = "processing";
    }

    const terminal = tasks.every(taskDone);
    const hasFailure = tasks.some((task) => task.status === "failed");
    const next = { ...current, tasks, phase: terminal ? (hasFailure ? "failed" : "complete") : "processing" };
    commit(next);
    if (terminal) void clearRecoveryFiles(next.id);
  };

  const submitRecovered = async (current) => {
    if (!networkFetch.current || !current || resumeAttempted.current) return;
    resumeAttempted.current = true;
    try {
      if (current.kind === "batch") {
        let sourceUrls = current.sourceUrls;
        if (!sourceUrls?.length) {
          const stored = await readRecoveryFiles(current.id);
          if (!stored.length) throw new Error("The original batch files are no longer available for refresh recovery.");
          const uploaded = [];
          for (let index = 0; index < stored.length; index++) {
            const entry = stored[index];
            const file = new File([entry.blob], entry.name || `recovery-${index + 1}.png`, { type: entry.type || entry.blob.type || "image/png" });
            const result = await upload(`pixora-inputs/recovery/${Date.now()}-${index}-${file.name}`, file, { access: "public" });
            uploaded.push(result.url);
          }
          sourceUrls = uploaded;
          current = { ...current, sourceUrls, sourceCount: sourceUrls.length, requestBody: { imageUrls: sourceUrls, prompt: current.prompt, aspectRatio: current.aspectRatio || "default" } };
          commit(current);
        }

        const adopted = bridgeTasksFor(current);
        if (adopted?.length) {
          commit({ ...current, tasks: adopted, phase: adopted.some((task) => task.taskId) ? "processing" : "failed", managedByRecovery: true });
          return;
        }

        const response = await networkFetch.current("/api/generate-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(current.requestBody || { imageUrls: sourceUrls, prompt: current.prompt, aspectRatio: current.aspectRatio || "default" }),
        });
        const data = await response.json();
        const tasks = (data.tasks || []).map((task) => ({ index: task.index, taskId: task.taskId, status: task.taskId ? "queued" : "failed", error: task.error }));
        commit({ ...current, tasks, phase: tasks.some((task) => task.taskId) ? "processing" : "failed", managedByRecovery: true, bootId: currentBoot.current });
        return;
      }

      let body = current.requestBody;
      if (!body?.imageUrl) {
        const stored = await readRecoveryFiles(current.id);
        if (!stored.length) throw new Error("The original image is no longer available for refresh recovery.");
        const first = stored[0];
        const file = new File([first.blob], first.name || "recovery-main.png", { type: first.type || first.blob.type || "image/png" });
        const main = await upload(`pixora-inputs/recovery/${Date.now()}-${file.name}`, file, { access: "public" });
        body = { imageUrl: main.url, prompt: current.prompt, aspectRatio: current.aspectRatio || "default" };
        if (current.kind === "reference" && stored[1]) {
          const second = stored[1];
          const refFile = new File([second.blob], second.name || "recovery-reference.png", { type: second.type || second.blob.type || "image/png" });
          const ref = await upload(`pixora-inputs/recovery/${Date.now()}-${refFile.name}`, refFile, { access: "public" });
          body.referenceImageUrl = ref.url;
        }
        current = { ...current, requestBody: body };
        commit(current);
      }

      const response = await networkFetch.current("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      const task = data.taskId ? { index: 0, taskId: data.taskId, status: "queued" } : { index: 0, status: "failed", error: data.error || "Could not start generation" };
      commit({ ...current, tasks: [task], phase: task.taskId ? "processing" : "failed", managedByRecovery: true, bootId: currentBoot.current });
    } catch (error) {
      commit({ ...current, phase: "failed", recoveryError: error instanceof Error ? error.message : "Could not recover this job." });
    }
  };

  useEffect(() => {
    const existing = readJson(ACTIVE_JOB_KEY);

    // v1.2+ batch processing is a bounded streaming queue owned by Editor.
    // Old batch recovery snapshots describe the previous all-at-once flow and must
    // not take over the new queue after a refresh.
    if (existing?.kind === "batch") {
      writeJob(null);
      void clearRecoveryFiles(existing.id);
      return;
    }

    if (freshJob(existing)) {
      jobRef.current = existing;
      setJob(existing);
      const isRecovered = existing.bootId !== currentBoot.current && ["uploading", "submitting", "processing"].includes(existing.phase);
      setRecovered(isRecovered);
      if (isRecovered) syncRecoveredInline(existing);
    } else if (existing) {
      writeJob(null);
    }
  }, []);

  useEffect(() => {
    localStorage.removeItem(LEGACY_ACTIVE_JOB_KEY);
    const originalFetch = window.fetch.bind(window);
    networkFetch.current = originalFetch;

    const onGenerateIntent = (event) => {
      const button = event.target?.closest?.("button.generate");
      if (!button || button.disabled) return;

      // Batch mode now owns a bounded streaming queue in Editor. Treating every
      // per-image queue request as a whole recoverable batch would overwrite task state.
      if (button.closest(".batchWorkspace")) return;

      const batchControls = button.closest(".batchWorkspace")?.querySelector(".controls");
      const singleControls = button.closest(".workspace")?.querySelector(".controls");
      const workspace = button.closest(".workspace");
      if (!workspace) return;

      let kind = "single";
      let sources = [];
      let prompt = "";
      let aspectRatio = "default";
      let face = false;
      let pose = false;

      if (button.closest(".batchWorkspace")) {
        kind = "batch";
        prompt = batchControls?.querySelector("#batch-prompt")?.value || "";
        aspectRatio = ratioFromControls(batchControls);
        const locks = batchControls?.querySelectorAll(".preserveOptions input") || [];
        face = Boolean(locks[0]?.checked); pose = Boolean(locks[1]?.checked);
        sources = previewSources(button.closest(".batchWorkspace"));
      } else if (workspace.classList.contains("referenceWorkspace")) {
        kind = "reference";
        prompt = singleControls?.querySelector("#reference-prompt")?.value || "";
        aspectRatio = ratioFromControls(singleControls);
        const locks = singleControls?.querySelectorAll(".preserveOptions input") || [];
        face = Boolean(locks[0]?.checked); pose = Boolean(locks[1]?.checked);
        sources = Array.from(workspace.querySelectorAll(".referenceUploads img")).map((img) => img.src).filter(Boolean);
      } else {
        kind = "single";
        prompt = singleControls?.querySelector("#single-prompt")?.value || "";
        aspectRatio = ratioFromControls(singleControls);
        const locks = singleControls?.querySelectorAll(".preserveOptions input") || [];
        face = Boolean(locks[0]?.checked); pose = Boolean(locks[1]?.checked);
        const src = workspace.querySelector(".dropzone img")?.src;
        if (src) sources = [src];
      }

      if (!sources.length || !prompt.trim()) return;
      const id = bootId();
      const finalPrompt = applyPreservation(prompt, face, pose, kind === "reference");
      const next = {
        id,
        bootId: currentBoot.current,
        kind,
        phase: "uploading",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        prompt: finalPrompt,
        userPrompt: prompt,
        aspectRatio,
        sourceCount: sources.length,
        sourceUrls: [],
        tasks: [],
      };
      commit(next);
      // Avoid duplicating dozens of full-size source blobs in memory during a large mobile batch.
      // Uploaded URLs and task IDs still make the job refresh-safe after submission.
      if (sources.length <= 10) {
        void blobsFromSources(sources).then((files) => storeRecoveryFiles(id, files)).catch(() => undefined);
      }
    };

    document.addEventListener("click", onGenerateIntent, true);

    const patchedFetch = async (input, init) => {
      const url = new URL(requestUrl(input), window.location.href);
      const method = requestMethod(input, init);
      const headers = new Headers(init?.headers || {});
      const queueItemRequest = headers.get("X-Pixora-Queue-Item") === "1";

      // Streaming batch items are managed by Editor's bounded queue, not by the
      // single-job recovery bridge. This prevents parallel item requests from
      // replacing each other's recovery metadata.
      if (queueItemRequest) return originalFetch(input, init);

      if (url.origin === window.location.origin && method === "POST" && (url.pathname === "/api/generate" || url.pathname === "/api/generate-batch")) {
        const body = bodyJson(init);
        const current = jobRef.current;
        const kind = url.pathname === "/api/generate-batch" ? "batch" : (body?.referenceImageUrl ? "reference" : "single");
        const id = current?.phase === "uploading" && current.kind === kind ? current.id : bootId();
        const prepared = {
          ...(current?.id === id ? current : {}),
          id,
          bootId: currentBoot.current,
          kind,
          phase: "submitting",
          createdAt: current?.id === id ? current.createdAt : Date.now(),
          prompt: body?.prompt || current?.prompt || "",
          aspectRatio: body?.aspectRatio || current?.aspectRatio || "default",
          requestBody: body,
          sourceUrls: kind === "batch" ? (body?.imageUrls || []) : [body?.imageUrl].filter(Boolean),
          sourceCount: kind === "batch" ? (body?.imageUrls?.length || 0) : 1,
          tasks: [],
        };
        commit(prepared);

        let response;
        try { response = await originalFetch(input, init); }
        catch (error) {
          commit({ ...prepared, phase: "failed", recoveryError: error instanceof Error ? error.message : "Network request failed" });
          throw error;
        }

        try {
          const data = await response.clone().json();
          if (kind === "batch") {
            const tasks = (data.tasks || []).map((task) => ({ index: task.index, taskId: task.taskId, status: task.taskId ? "queued" : "failed", error: task.error }));
            commit({ ...prepared, tasks, phase: tasks.some((task) => task.taskId) ? "processing" : "failed" });
          } else {
            const task = data.taskId ? { index: 0, taskId: data.taskId, status: "queued" } : { index: 0, status: "failed", error: data.error || "Could not start generation" };
            commit({ ...prepared, tasks: [task], phase: task.taskId ? "processing" : "failed" });
          }
        } catch {
          if (!response.ok) commit({ ...prepared, phase: "failed", recoveryError: `Request failed (${response.status})` });
        }
        return response;
      }

      if (url.origin === window.location.origin && url.pathname === "/api/task" && method === "GET") {
        const taskId = url.searchParams.get("id") || "";
        const response = await originalFetch(input, init);
        try {
          const data = await response.clone().json();
          markTaskFromPoll(taskId, data, response.ok);
        } catch {}
        return response;
      }

      return originalFetch(input, init);
    };

    window.fetch = patchedFetch;
    return () => {
      document.removeEventListener("click", onGenerateIntent, true);
      if (window.fetch === patchedFetch) window.fetch = originalFetch;
    };
  }, []);

  useEffect(() => {
    const current = jobRef.current;
    if (!current || !freshJob(current)) return;
    if (current.bootId === currentBoot.current && !current.managedByRecovery) return;
    if (current.phase === "submitting" || current.phase === "uploading") {
      // Never submit a new paid VModel request automatically after a refresh. Existing task
      // IDs may still be polled safely, but restarting a request requires an explicit retry.
      commit({ ...current, phase: "failed", recoveryError: "The page refreshed before submission finished. Nothing was restarted automatically; retry only if you choose to." });
    }
  }, [recovered]);

  useEffect(() => {
    const current = job;
    if (!current || current.phase !== "processing") return;
    const shouldOwnPolling = current.bootId !== currentBoot.current || current.managedByRecovery || recovered;
    if (!shouldOwnPolling) return;

    let stopped = false;
    const tick = async () => {
      if (stopped || pollingRef.current) return;
      const latest = jobRef.current;
      if (!latest || latest.phase !== "processing") return;
      pollingRef.current = true;
      try {
        const pending = (latest.tasks || []).filter((task) => task.taskId && !taskDone(task));
        await Promise.all(pending.map((task) => window.fetch(`/api/task?id=${encodeURIComponent(task.taskId)}`, { cache: "no-store" }).catch(() => undefined)));
      } finally {
        pollingRef.current = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [job?.id, job?.phase, job?.bootId, job?.managedByRecovery, recovered]);

  useEffect(() => {
    if (!job || !recovered || job.kind !== "batch" || !["submitting", "processing"].includes(job.phase)) return;
    syncRecoveredInline(job);
    const timer = window.setInterval(() => syncRecoveredInline(jobRef.current), 450);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.phase, recovered]);

  const retrySingle = async () => {
    const current = jobRef.current;
    if (!current || !networkFetch.current) return;
    setMessage("Retrying…");
    resumeAttempted.current = false;
    const next = { ...current, phase: "submitting", managedByRecovery: true, bootId: currentBoot.current, tasks: [] };
    commit(next);
    await submitRecovered(next);
    setMessage("");
  };

  const retryGroup = async (indexes) => {
    const current = jobRef.current;
    if (!current || current.kind !== "batch" || !networkFetch.current) return;
    const label = indexes.length === 2 ? `images ${indexes[0] + 1} & ${indexes[1] + 1}` : `image ${indexes[0] + 1}`;
    if (!window.confirm(`Retry ${label}? This will use another VModel request.`)) return;
    const urls = indexes.map((index) => current.sourceUrls?.[index]).filter(Boolean);
    if (urls.length !== indexes.length) {
      setMessage("The uploaded source for this failed item is no longer available.");
      return;
    }
    setMessage(`Retrying ${label}…`);
    try {
      const response = await networkFetch.current("/api/generate-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrls: urls, prompt: current.prompt, aspectRatio: current.aspectRatio || "default" }),
      });
      const data = await response.json();
      const replacements = (data.tasks || []).map((task, localIndex) => ({
        index: indexes[localIndex],
        taskId: task.taskId,
        status: task.taskId ? "queued" : "failed",
        error: task.error,
      }));
      const replacementMap = new Map(replacements.map((task) => [task.index, task]));
      const tasks = [];
      const count = Number(current.sourceCount || current.sourceUrls?.length || 0);
      for (let index = 0; index < count; index++) {
        tasks.push(replacementMap.get(index) || current.tasks?.find((task) => task.index === index) || { index, status: "failed", error: "Missing task state" });
      }
      commit({ ...current, tasks, phase: tasks.some((task) => task.taskId && !taskDone(task)) ? "processing" : "failed", managedByRecovery: true, bootId: currentBoot.current });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Retry failed to start.");
      return;
    }
    setMessage("");
  };

  const failures = useMemo(() => failedGroups(job), [job]);
  const isRecoveredActive = Boolean(job && recovered && ["uploading", "submitting", "processing"].includes(job.phase));
  const show = Boolean(job && (isRecoveredActive || failures.length || job.recoveryError));
  if (!show) return null;

  const total = Number(job.sourceCount || job.sourceUrls?.length || 1);
  const done = (job.tasks || []).filter((task) => task.status === "done").length;
  const failed = (job.tasks || []).filter((task) => task.status === "failed").length;
  const closeAll = () => {
    const id = job?.id;
    writeJob(null);
    localStorage.removeItem(BRIDGE_BATCH_KEY);
    setJob(null);
    setMessage("");
    if (id) void clearRecoveryFiles(id);
  };

  return <div className="pxRecoveryPanel" aria-live="polite">
    <style>{`
      .pxRecoveryPanel{position:fixed;z-index:8995;left:18px;bottom:18px;width:min(390px,calc(100vw - 36px));max-height:min(72vh,560px);display:flex;flex-direction:column;padding:14px;border:1px solid rgba(126,150,60,.42);border-radius:17px;background:rgba(247,248,241,.97);box-shadow:0 18px 55px rgba(18,28,20,.2);backdrop-filter:blur(12px);color:#171914;font-family:var(--font-geist),Arial,sans-serif;overflow:hidden}.pxRecoveryPanel small{display:block;color:#73804e;font-size:9px;font-weight:850;letter-spacing:.09em;text-transform:uppercase}.pxRecoveryPanel h4{margin:4px 0 5px;font:800 14px var(--font-manrope),Arial,sans-serif}.pxRecoveryPanel p{margin:0;color:#6d7169;font-size:10px;line-height:1.45}.pxRecoveryStats{display:flex;gap:10px;margin-top:9px;font-size:9px;color:#747870}.pxRecoveryStats b{color:#173d2d}.pxRetryList{display:grid;gap:7px;margin-top:10px;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding-right:3px}.pxRetryRow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;border:1px solid #dedfd5;border-radius:11px;background:#fff}.pxRetryRow span{font-size:10px;font-weight:750}.pxRetryRow button,.pxRetrySingle{border:0;border-radius:9px;background:#173d2d;color:#e7f7b9;padding:7px 10px;font-size:9px;font-weight:850;cursor:pointer}.pxRecoveryMsg{margin-top:8px!important;color:#845b31!important}.pxRecoveryDismiss{position:absolute;right:10px;top:9px;border:0;background:transparent;color:#777;font-size:18px;cursor:pointer}.pxRecoveryCloseAll{flex:0 0 auto;width:100%;margin-top:10px;padding:10px 12px;border:0;border-radius:11px;background:#272a25;color:#fff;font-size:10px;font-weight:850;cursor:pointer}@media(max-width:620px){.pxRecoveryPanel{left:12px;right:12px;bottom:12px;width:auto;max-height:58vh}}
    `}</style>
    {!isRecoveredActive && <button type="button" className="pxRecoveryDismiss" onClick={() => { if (job?.phase !== "processing") { writeJob(null); setJob(null); } }} aria-label="Dismiss recovery panel">×</button>}
    <small>{isRecoveredActive ? "REFRESH RECOVERY ACTIVE" : "RETRY AVAILABLE"}</small>
    <h4>{isRecoveredActive ? "Your generation resumed automatically" : job.kind === "batch" ? "Some batch images failed" : "Generation failed"}</h4>
    <p>{isRecoveredActive ? "Pixora restored the saved task IDs and is continuing to poll V-Editor from where the page was refreshed." : "Retry only the failed work. Successful outputs are kept unchanged."}</p>
    <div className="pxRecoveryStats"><span><b>{done}</b> ready</span><span><b>{failed}</b> failed</span><span><b>{total}</b> total</span></div>
    {job.recoveryError && <p className="pxRecoveryMsg">{job.recoveryError}</p>}
    {failures.length > 0 && <div className="pxRetryList">
      {job.kind === "batch" ? failures.map((indexes) => <div className="pxRetryRow" key={indexes.join("-")}><span>{indexes.length === 2 ? `Images ${indexes[0] + 1} & ${indexes[1] + 1} failed` : `Image ${indexes[0] + 1} failed`}</span><button type="button" onClick={() => void retryGroup(indexes)}>Retry {indexes.length === 2 ? "both" : "image"}</button></div>) : <button type="button" className="pxRetrySingle" onClick={() => void retrySingle()}>Retry same image</button>}
    </div>}
    {message && <p className="pxRecoveryMsg">{message}</p>}
    <button type="button" className="pxRecoveryCloseAll" onClick={closeAll}>Close all</button>
  </div>;
}
