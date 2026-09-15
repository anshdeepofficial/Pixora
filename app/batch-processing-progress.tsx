// @ts-nocheck
"use client";

import { useEffect, useRef, useState } from "react";

const PHASE_RANK = { idle: 0, upload: 1, prepare: 2, generate: 3, finalizing: 4, complete: 5, error: 6 };
const PAIR_PROGRESS_EVENT = "pixora:batch-pair-progress";

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

function safeJsonBody(input, init) {
  if (typeof init?.body === "string") {
    try { return JSON.parse(init.body); } catch { return null; }
  }
  return null;
}

function stageState(currentRank, stageRank) {
  if (currentRank > stageRank) return "done";
  if (currentRank === stageRank) return "active";
  return "waiting";
}

export default function BatchProcessingProgress() {
  const [state, setState] = useState({
    visible: false,
    phase: "idle",
    title: "",
    detail: "",
    percent: null,
    sourceCount: 0,
    requestCount: 0,
    delivered: 0,
    failed: 0,
  });
  const phaseRef = useRef("idle");
  const sourceCountRef = useRef(0);
  const requestCountRef = useRef(0);
  const completedTaskIds = useRef(new Set());
  const failedTaskIds = useRef(new Set());
  const hideTimer = useRef(null);
  const dismissedRef = useRef(false);

  const update = (patch, force = false) => {
    if (!force && patch?.visible && dismissedRef.current) return;
    setState((current) => {
      const next = { ...current, ...patch };
      phaseRef.current = next.phase;
      sourceCountRef.current = next.sourceCount || sourceCountRef.current;
      requestCountRef.current = next.requestCount || requestCountRef.current;
      return next;
    });
  };

  const hideAfterComplete = () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      setState((current) => ({ ...current, visible: false }));
    }, 2000);
  };

  useEffect(() => {
    const originalFetch = window.fetch.bind(window);

    const onPairProgress = (event) => {
      if (dismissedRef.current) return;
      const detail = event?.detail || {};
      const percent = Number(detail.percent);
      update({
        visible: true,
        phase: "prepare",
        title: "Combining & uploading smart batches",
        detail: detail.detail || "Building lossless local collages from the original images…",
        percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
      });
    };
    window.addEventListener(PAIR_PROGRESS_EVENT, onPairProgress);

    const readUploadProgress = () => {
      if (PHASE_RANK[phaseRef.current] > PHASE_RANK.upload) return;
      const cards = Array.from(document.querySelectorAll(".batchCard"));
      if (!cards.length) return;

      const uploading = cards.some((card) => card.classList.contains("uploading") || /Starting upload|Uploading/i.test(card.textContent || ""));
      if (!uploading && phaseRef.current !== "upload") return;

      let totalProgress = 0;
      let finished = 0;
      let failed = 0;
      for (const card of cards) {
        const text = card.textContent || "";
        const match = text.match(/Uploading\s*·?\s*(\d+)%/i);
        if (match) {
          totalProgress += Math.max(0, Math.min(100, Number(match[1])));
        } else if (/Uploaded\s*·\s*creating task/i.test(text) || card.classList.contains("queued") || card.classList.contains("processing") || card.classList.contains("done")) {
          totalProgress += 100;
          finished += 1;
        } else if (card.classList.contains("failed")) {
          totalProgress += 100;
          finished += 1;
          failed += 1;
        }
      }

      const percent = cards.length ? totalProgress / cards.length : 0;
      sourceCountRef.current = cards.length;
      update({
        visible: true,
        phase: "upload",
        title: "Uploading original images",
        detail: `${finished}/${cards.length} uploads finished${failed ? ` · ${failed} failed` : ""}`,
        percent,
        sourceCount: cards.length,
        delivered: 0,
        failed,
      });
    };

    const observer = new MutationObserver(readUploadProgress);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style"] });

    const patchedFetch = async (input, init) => {
      const url = new URL(requestUrl(input), window.location.href);
      const method = requestMethod(input, init);

      if (url.origin === window.location.origin && url.pathname === "/api/generate-batch" && method === "POST") {
        const body = safeJsonBody(input, init);
        const sourceCount = Array.isArray(body?.imageUrls) ? body.imageUrls.length : sourceCountRef.current;
        const expectedRequests = Math.ceil(sourceCount / 2);
        sourceCountRef.current = sourceCount;
        completedTaskIds.current.clear();
        failedTaskIds.current.clear();
        if (hideTimer.current) window.clearTimeout(hideTimer.current);

        // A POST entered from the upload phase belongs to the same batch. If the user already
        // closed the floating card, keep it closed. Otherwise a completed/idle previous batch
        // starts a fresh visible progress card.
        if (!["upload", "prepare", "generate", "finalizing"].includes(phaseRef.current)) dismissedRef.current = false;

        update({
          visible: true,
          phase: "prepare",
          title: sourceCount > 1 ? "Combining & uploading smart batches" : "Preparing AI request",
          detail: sourceCount > 1
            ? `${sourceCount} uploaded images → ${expectedRequests} smart batch${expectedRequests === 1 ? "" : "es"}. Using local originals for pairing — no re-download.`
            : "The uploaded image is being prepared for V-Editor.",
          percent: sourceCount > 1 ? 1 : null,
          sourceCount,
          requestCount: expectedRequests,
          delivered: 0,
          failed: 0,
        });

        let response;
        try {
          response = await originalFetch(input, init);
        } catch (error) {
          update({ visible: true, phase: "error", title: "Could not start batch processing", detail: error instanceof Error ? error.message : "Network request failed.", percent: null });
          throw error;
        }

        try {
          const data = await response.clone().json();
          const realRequests = Number(data?.vmodelRequestCount) || (Array.isArray(data?.tasks) ? Math.max(1, Math.ceil(sourceCount / 2)) : expectedRequests);
          requestCountRef.current = realRequests;
          if (response.ok || Array.isArray(data?.tasks)) {
            update({
              visible: true,
              phase: "generate",
              title: "V-Editor generation started",
              detail: `${realRequests} real VModel generation request${realRequests === 1 ? "" : "s"} accepted. Paired requests use maximum result resolution.`,
              percent: null,
              sourceCount,
              requestCount: realRequests,
            });
          } else {
            update({ visible: true, phase: "error", title: "V-Editor could not start", detail: data?.error || "Batch generation request failed.", percent: null });
          }
        } catch {
          if (!response.ok) update({ visible: true, phase: "error", title: "V-Editor could not start", detail: `Request failed (${response.status}).`, percent: null });
        }
        return response;
      }

      if (url.origin === window.location.origin && url.pathname === "/api/task" && method === "GET" && PHASE_RANK[phaseRef.current] >= PHASE_RANK.generate && PHASE_RANK[phaseRef.current] < PHASE_RANK.complete) {
        const taskId = url.searchParams.get("id") || "unknown";
        let response;
        try {
          response = await originalFetch(input, init);
        } catch (error) {
          update({ visible: true, phase: "error", title: "Could not check AI result", detail: error instanceof Error ? error.message : "Task status request failed.", percent: null });
          throw error;
        }

        try {
          const data = await response.clone().json();
          const status = String(data?.status || "processing").replace(/_/g, " ");
          if (!response.ok) {
            update({ visible: true, phase: "error", title: "Could not check AI result", detail: data?.error || `Task check failed (${response.status}).`, percent: null });
            return response;
          }

          if (data?.status === "failed") {
            failedTaskIds.current.add(taskId);
            const failed = failedTaskIds.current.size;
            const delivered = completedTaskIds.current.size;
            update({
              visible: true,
              phase: "finalizing",
              title: "One output failed",
              detail: `${delivered}/${sourceCountRef.current} final outputs delivered · ${failed} failed`,
              percent: sourceCountRef.current ? ((delivered + failed) / sourceCountRef.current) * 100 : null,
              delivered,
              failed,
            });
          } else if (data?.status === "succeeded" && Array.isArray(data?.output) && data.output[0]) {
            completedTaskIds.current.add(taskId);
            const delivered = completedTaskIds.current.size;
            const failed = failedTaskIds.current.size;
            const total = sourceCountRef.current || delivered + failed;
            const finished = delivered + failed;
            update({
              visible: true,
              phase: finished >= total ? "complete" : "finalizing",
              title: finished >= total ? "Batch processing complete" : "AI result received · splitting & saving",
              detail: finished >= total
                ? `${delivered} final image${delivered === 1 ? "" : "s"} ready${failed ? ` · ${failed} failed` : ""}.`
                : `Paired AI output has been separated and saved as PNG · ${delivered}/${total}`,
              percent: total ? (finished / total) * 100 : 100,
              delivered,
              failed,
            });
            if (finished >= total) hideAfterComplete();
          } else {
            update({
              visible: true,
              phase: "generate",
              title: `V-Editor ${status}`,
              detail: `${requestCountRef.current || Math.ceil((sourceCountRef.current || 1) / 2)} real generation request${(requestCountRef.current || 1) === 1 ? "" : "s"} · waiting for VModel to finish.`,
              percent: null,
            });
          }
        } catch {
          // Keep the previous truthful stage if a status body cannot be parsed.
        }
        return response;
      }

      return originalFetch(input, init);
    };

    window.fetch = patchedFetch;
    readUploadProgress();

    return () => {
      observer.disconnect();
      window.removeEventListener(PAIR_PROGRESS_EVENT, onPairProgress);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      if (window.fetch === patchedFetch) window.fetch = originalFetch;
    };
  }, []);

  if (!state.visible) return null;

  const rank = PHASE_RANK[state.phase] || 0;
  const isIndeterminate = state.percent === null && state.phase !== "error";
  const prepareLabel = state.sourceCount > 1 ? "Build smart batches" : "Prepare request";
  const stages = [
    { label: "Upload originals", rank: 1 },
    { label: prepareLabel, rank: 2 },
    { label: "V-Editor generation", rank: 3 },
    { label: "Split & save outputs", rank: 4 },
  ];

  const closeProgress = () => {
    dismissedRef.current = true;
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    setState((current) => ({ ...current, visible: false }));
  };

  return <div className={`pxBatchProgress ${state.phase}`} role="status" aria-live="polite">
    <style>{`
      .pxBatchProgress{position:fixed;z-index:9000;right:18px;bottom:18px;width:min(410px,calc(100vw - 36px));padding:16px;border:1px solid rgba(208,205,194,.92);border-radius:18px;background:rgba(251,250,246,.97);box-shadow:0 22px 70px rgba(20,24,19,.22);backdrop-filter:blur(12px);color:#161714;font-family:var(--font-geist),Arial,sans-serif}
      .pxBatchProgressHead{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.pxBatchProgressHead small{display:block;margin-bottom:4px;color:#7a7d76;font-size:9px;font-weight:800;letter-spacing:.09em;text-transform:uppercase}.pxBatchProgressHead strong{display:block;font:800 14px var(--font-manrope);letter-spacing:-.02em}.pxBatchHeadActions{display:flex;align-items:center;gap:7px;flex:0 0 auto}.pxBatchRequest{padding:5px 8px;border-radius:99px;background:#eaf2d1;color:#40571d;font-size:9px;font-weight:850;white-space:nowrap}.pxBatchClose{display:grid;place-items:center;width:26px;height:26px;padding:0;border:1px solid #d9d6cc;border-radius:50%;background:#f4f2ec;color:#62665f;font-size:17px;line-height:1;cursor:pointer;transition:.15s ease}.pxBatchClose:hover{background:#ebe8df;color:#151713;transform:scale(1.04)}
      .pxBatchDetail{margin:7px 0 11px;color:#6e726b;font-size:10px;line-height:1.45}.pxBatchTrack{height:7px;overflow:hidden;border-radius:99px;background:#e1dfd7}.pxBatchTrack i{display:block;height:100%;border-radius:inherit;background:#73952d;transition:width .2s ease}.pxBatchTrack.indeterminate i{width:38%;animation:pxBatchSweep 1.15s ease-in-out infinite}.pxBatchProgress.error .pxBatchTrack i{background:#b95242}.pxBatchProgress.complete .pxBatchTrack i{width:100%;background:#5e8a2c}
      .pxBatchStages{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-top:12px}.pxBatchStage{min-width:0;padding:7px 5px;border:1px solid #ddd9cf;border-radius:9px;background:#f7f5ef;text-align:center;color:#9a9c96;font-size:8px;font-weight:750;line-height:1.25}.pxBatchStage.done{border-color:#d6e5aa;background:#f0f6df;color:#547126}.pxBatchStage.active{border-color:#7e963c;background:#173d2d;color:#d7f47c}.pxBatchStage span{display:block;margin-bottom:2px;font-size:10px}.pxBatchNumbers{display:flex;gap:10px;margin-top:10px;color:#82857f;font-size:9px}.pxBatchNumbers b{color:#173d2d}
      @keyframes pxBatchSweep{0%{transform:translateX(-110%)}50%{transform:translateX(100%)}100%{transform:translateX(260%)}}
      @media(max-width:620px){.pxBatchProgress{left:12px;right:12px;bottom:12px;width:auto;border-radius:16px;padding:14px}.pxBatchStages{gap:4px}.pxBatchStage{font-size:7.5px;padding:6px 3px}.pxBatchRequest{font-size:8px}.pxBatchClose{width:25px;height:25px}}
    `}</style>
    <div className="pxBatchProgressHead">
      <div><small>LIVE BATCH PROCESSING</small><strong>{state.title}</strong></div>
      <div className="pxBatchHeadActions">
        {state.requestCount > 0 && <span className="pxBatchRequest">{state.requestCount} VModel request{state.requestCount === 1 ? "" : "s"}</span>}
        <button type="button" className="pxBatchClose" onClick={closeProgress} aria-label="Close batch progress">×</button>
      </div>
    </div>
    <p className="pxBatchDetail">{state.detail}</p>
    <div className={`pxBatchTrack ${isIndeterminate ? "indeterminate" : ""}`}><i style={isIndeterminate ? undefined : { width: `${Math.max(0, Math.min(100, state.percent ?? 0))}%` }} /></div>
    <div className="pxBatchStages">{stages.map((stage, index) => {
      const status = state.phase === "error" ? (rank > stage.rank ? "done" : "waiting") : stageState(rank, stage.rank);
      return <div className={`pxBatchStage ${status}`} key={stage.label}><span>{status === "done" ? "✓" : status === "active" ? "●" : index + 1}</span>{stage.label}</div>;
    })}</div>
    <div className="pxBatchNumbers">
      {state.sourceCount > 0 && <span><b>{state.sourceCount}</b> source image{state.sourceCount === 1 ? "" : "s"}</span>}
      {state.delivered > 0 && <span><b>{state.delivered}</b> delivered</span>}
      {state.failed > 0 && <span><b>{state.failed}</b> failed</span>}
    </div>
  </div>;
}
