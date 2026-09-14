// @ts-nocheck
"use client";

import { useEffect, useRef, useState } from "react";

const CACHE_KEY = "pixora-imagekit-ai-upscale-v1";
const POLL_MS = 2_000;
const MAX_POLLS = 90;
const EXTENSION_UNITS_PER_IMAGE = 5;

function unique(values) { return Array.from(new Set(values.filter(Boolean))); }
function imgSrc(img) { return img?.currentSrc || img?.src || ""; }
function selectedHistoryUrls() { return unique(Array.from(document.querySelectorAll(".historyGrid article.selected img")).map(imgSrc)); }
function batchOutputUrls() { return unique(Array.from(document.querySelectorAll(".batchOutputGrid article img")).map(imgSrc)); }

function resolveAction(button) {
  const text = (button.textContent || "").trim().toLowerCase();
  if (button.classList.contains("downloadSelected")) return null;

  if (button.closest(".historyCaption") && (button.getAttribute("aria-label") || "").toLowerCase().includes("download")) {
    const url = imgSrc(button.closest("article")?.querySelector("img"));
    return url ? { urls: [url], kind: "single", label: "Download image" } : null;
  }
  if (button.closest(".resultActions") && text.includes("download")) {
    const url = imgSrc(button.closest(".resultCard")?.querySelector("img"));
    return url ? { urls: [url], kind: "single", label: "Download image" } : null;
  }
  const outputArticle = button.closest(".batchOutputGrid article");
  if (outputArticle && text.includes("download")) {
    const url = imgSrc(outputArticle.querySelector("img"));
    return url ? { urls: [url], kind: "single", label: "Download batch image" } : null;
  }
  if (button.closest(".batchResultActions") && text.includes("download")) {
    const card = button.closest(".batchCard");
    const readyCards = Array.from(document.querySelectorAll(".batchCard")).filter((entry) => entry.querySelector(".batchResultActions"));
    const results = Array.from(document.querySelectorAll(".batchOutputGrid article img"));
    const index = readyCards.indexOf(card);
    const url = index >= 0 ? imgSrc(results[index]) : "";
    return url ? { urls: [url], kind: "single", label: "Download batch image" } : null;
  }
  if (button.closest(".batchOutputHead")) {
    const urls = batchOutputUrls();
    if (!urls.length) return null;
    if (text.includes("zip")) return { urls, kind: "zip", label: `Download ${urls.length} batch images` };
    if (text.includes("separate")) return { urls, kind: "separate", label: `Download ${urls.length} batch images` };
  }
  if (button.closest(".downloadMenu")) {
    const urls = selectedHistoryUrls();
    if (!urls.length) return null;
    if (text.includes("zip")) return { urls, kind: "zip", label: `Download ${urls.length} selected images` };
    if (text.includes("separate")) return { urls, kind: "separate", label: `Download ${urls.length} selected images` };
  }
  return null;
}

function readCache() {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}
function getCachedUrl(url) { return readCache()[url]?.url || ""; }
function rememberEnhancedUrl(sourceUrl, enhancedUrl) {
  try {
    const cache = readCache();
    cache[sourceUrl] = { url: enhancedUrl, savedAt: Date.now() };
    const entries = Object.entries(cache)
      .sort((a, b) => (b[1]?.savedAt || 0) - (a[1]?.savedAt || 0))
      .slice(0, 200);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function enhancedUrl(sourceUrl, onStatus) {
  const cached = getCachedUrl(sourceUrl);
  if (cached) {
    onStatus("cached");
    return { url: cached, cached: true };
  }

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    if (attempt > 0) await wait(POLL_MS);
    onStatus(attempt === 0 ? "starting" : "processing");

    const response = await fetch("/api/enhance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageUrl: sourceUrl }),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));

    if (response.status === 202 || data.status === "processing") continue;
    if (!response.ok) throw new Error(data.error || "ImageKit AI enhancement failed.");
    if (data.status === "succeeded" && data.output?.[0]) {
      rememberEnhancedUrl(sourceUrl, data.output[0]);
      return { url: data.output[0], cached: false };
    }
  }

  throw new Error("AI enhancement is taking longer than expected. Please try again shortly; no VModel credits were used.");
}

async function fetchImageBlob(url) {
  const params = new URLSearchParams({ url, filename: "pixora-ai-enhanced", disposition: "inline" });
  const response = await fetch(`/api/download?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) {
    let detail = "Could not download the enhanced image.";
    try { detail = (await response.json()).error || detail; } catch {}
    throw new Error(detail);
  }
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("The enhancement service returned an invalid image.");
  return blob;
}
function extensionForBlob(blob) {
  if (blob.type.includes("jpeg")) return "jpg";
  if (blob.type.includes("webp")) return "webp";
  if (blob.type.includes("avif")) return "avif";
  return "png";
}
function save(blob, name) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 5000);
}
function closeSelectedMenu() {
  if (!document.querySelector(".downloadMenu")) return;
  document.querySelector(".downloadSelected")?.click();
}
function statusLabel(status) {
  if (status === "cached") return "Using saved enhanced result";
  if (status === "starting") return "Starting ImageKit AI Upscale";
  return "ImageKit AI is enhancing the image";
}

export default function DownloadEnhancementClient() {
  const bypass = useRef(new WeakSet());
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({ percent: 0, label: "", indeterminate: false });

  useEffect(() => {
    const capture = (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest("button");
      if (!button || button.disabled) return;
      if (bypass.current.has(button)) { bypass.current.delete(button); return; }
      const action = resolveAction(button);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setError("");
      setProgress({ percent: 0, label: "", indeterminate: false });
      setPending({ ...action, trigger: button });
    };
    document.addEventListener("click", capture, true);
    return () => document.removeEventListener("click", capture, true);
  }, []);

  const original = () => {
    if (!pending || busy) return;
    const trigger = pending.trigger;
    bypass.current.add(trigger);
    setPending(null);
    setError("");
    requestAnimationFrame(() => trigger.click());
  };

  const enhanced = async () => {
    if (!pending || busy) return;
    const action = pending;
    setBusy(true);
    setError("");
    closeSelectedMenu();

    try {
      const zip = action.kind === "zip" ? new (await import("jszip")).default() : null;

      for (let index = 0; index < action.urls.length; index++) {
        const number = index + 1;
        const base = (index / action.urls.length) * 100;
        const result = await enhancedUrl(action.urls[index], (status) => {
          setProgress({
            percent: base,
            label: `${statusLabel(status)} · ${number}/${action.urls.length}`,
            indeterminate: status !== "cached",
          });
        });

        setProgress({
          percent: base,
          label: result.cached ? `Loading saved enhanced image · ${number}/${action.urls.length}` : `Fetching enhanced image · ${number}/${action.urls.length}`,
          indeterminate: true,
        });
        const blob = await fetchImageBlob(result.url);
        const name = `pixora-ai-enhanced-${number}.${extensionForBlob(blob)}`;
        if (zip) zip.file(name, blob);
        else save(blob, name);

        setProgress({
          percent: ((index + 1) / action.urls.length) * 100,
          label: `Enhanced ${number} of ${action.urls.length}`,
          indeterminate: false,
        });
      }

      if (zip) {
        setProgress({ percent: 100, label: "Creating enhanced ZIP", indeterminate: true });
        const archive = await zip.generateAsync({ type: "blob", compression: "STORE" });
        save(archive, `pixora-ai-enhanced-${action.urls.length}-images.zip`);
      }

      setProgress({ percent: 100, label: "Enhanced download ready", indeterminate: false });
      setTimeout(() => {
        setPending(null);
        setBusy(false);
        setProgress({ percent: 0, label: "", indeterminate: false });
      }, 1000);
    } catch (reason) {
      setBusy(false);
      setProgress((current) => ({ ...current, indeterminate: false }));
      setError(reason instanceof Error ? reason.message : "Server-side AI enhancement failed.");
    }
  };

  if (!pending) return null;
  const units = pending.urls.length * EXTENSION_UNITS_PER_IMAGE;

  return <div className="pxEnhanceOverlay" role="dialog" aria-modal="true" aria-label="Download quality">
    <style>{`
      .pxEnhanceOverlay{position:fixed;z-index:10000;inset:0;background:rgba(18,20,17,.64);backdrop-filter:blur(8px);display:grid;place-items:center;padding:18px;font-family:var(--font-geist),Arial,sans-serif}.pxEnhanceCard{width:min(520px,100%);max-height:calc(100vh - 36px);overflow:auto;background:#fbfaf6;border:1px solid #d8d5cc;border-radius:22px;box-shadow:0 28px 90px rgba(0,0,0,.28);padding:22px;color:#161714}.pxEnhanceTop{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:17px}.pxEnhanceTop small{display:block;color:#72756d;font-size:11px;margin-bottom:5px}.pxEnhanceTop h3{margin:0;font:800 20px var(--font-manrope);letter-spacing:-.03em}.pxEnhanceClose{width:34px;height:34px;border:1px solid #d4d1c8;border-radius:50%;background:#fff;color:#555;cursor:pointer;font-size:19px}.pxEnhanceClose:disabled{opacity:.35}.pxEnhanceInfo{display:flex;gap:7px;align-items:center;margin:0 0 14px;padding:10px 12px;border-radius:11px;background:#eef4da;color:#395026;font-size:10px;font-weight:750}.pxEnhanceChoices{display:grid;gap:9px}.pxEnhanceChoice{width:100%;display:flex;align-items:center;gap:12px;border:1px solid #d3d0c6;border-radius:14px;background:#fff;padding:13px;text-align:left;cursor:pointer;color:#161714}.pxEnhanceChoice:hover{border-color:#82963e;background:#fbfdf5}.pxEnhanceChoice:disabled{opacity:.55;cursor:not-allowed}.pxEnhanceIcon{width:39px;height:39px;flex:0 0 39px;display:grid;place-items:center;border-radius:10px;background:#f0f0ea;font-weight:900;color:#173d2d}.pxEnhanceChoice.recommended .pxEnhanceIcon{background:#173d2d;color:#c8f04f}.pxEnhanceChoice>span:nth-child(2){min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}.pxEnhanceChoice strong{font-size:12px}.pxEnhanceChoice small{font-size:9px;color:#7d8079;line-height:1.4}.pxEnhanceBadge{font-size:8px;font-weight:900;color:#456015;background:#eaf2d1;border-radius:99px;padding:5px 7px;white-space:nowrap}.pxEnhanceProgress{margin-top:15px;padding:12px;border:1px solid #d5d2c8;border-radius:12px;background:#f5f4ee}.pxEnhanceProgressTop{display:flex;justify-content:space-between;gap:10px;font-size:10px;color:#666b63;margin-bottom:8px}.pxEnhanceProgressTop strong{white-space:nowrap}.pxEnhanceTrack{height:6px;border-radius:99px;background:#dfddd5;overflow:hidden}.pxEnhanceTrack i{height:100%;display:block;background:#73952d;border-radius:inherit;transition:width .18s ease}.pxEnhanceTrack.indeterminate i{width:36%!important;animation:pxEnhanceSweep 1.1s ease-in-out infinite}.pxEnhanceError{margin:13px 0 0;padding:11px;border-radius:10px;background:#fff1ec;color:#923c2f;font-size:10px;line-height:1.5}.pxEnhanceError button{margin-top:8px;border:1px solid #d5c5bf;border-radius:8px;background:#fff;padding:8px 10px;color:#6e3329;font-size:9px;font-weight:750;cursor:pointer}.pxEnhanceFoot{margin:14px 2px 0;color:#898b86;font-size:9px;line-height:1.5}.pxEnhanceFoot b{color:#61655e}@keyframes pxEnhanceSweep{0%{transform:translateX(-120%)}50%{transform:translateX(110%)}100%{transform:translateX(280%)}}@media(max-width:560px){.pxEnhanceOverlay{align-items:end;padding:10px}.pxEnhanceCard{border-radius:20px 20px 14px 14px;padding:18px}.pxEnhanceBadge{display:none}}
    `}</style>
    <div className="pxEnhanceCard">
      <div className="pxEnhanceTop"><div><small>{pending.label} · {pending.urls.length} image{pending.urls.length === 1 ? "" : "s"}</small><h3>Choose download quality</h3></div><button type="button" className="pxEnhanceClose" disabled={busy} onClick={() => setPending(null)} aria-label="Close">×</button></div>
      <p className="pxEnhanceInfo"><b>Server-side AI</b><span>ImageKit AI Upscale · no VModel enhancement · no phone-side model</span></p>
      <div className="pxEnhanceChoices">
        <button type="button" className="pxEnhanceChoice" disabled={busy} onClick={original}><span className="pxEnhanceIcon">1×</span><span><strong>Original</strong><small>Exactly as generated · no enhancement usage</small></span><span className="pxEnhanceBadge">INSTANT</span></button>
        <button type="button" className="pxEnhanceChoice recommended" disabled={busy} onClick={enhanced}><span className="pxEnhanceIcon">AI</span><span><strong>AI Enhanced · 16MP</strong><small>ImageKit server-side AI upscaling and detail improvement</small></span><span className="pxEnhanceBadge">RECOMMENDED</span></button>
      </div>
      {(busy || progress.percent > 0) && <div className="pxEnhanceProgress" aria-live="polite"><div className="pxEnhanceProgressTop"><span>{progress.label || "Preparing enhancement"}</span><strong>{progress.indeterminate ? "Processing…" : `${Math.round(progress.percent)}%`}</strong></div><div className={`pxEnhanceTrack ${progress.indeterminate ? "indeterminate" : ""}`}><i style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} /></div></div>}
      {error && <div className="pxEnhanceError" role="alert">{error}<br/><button type="button" onClick={original}>Download original instead</button></div>}
      <p className="pxEnhanceFoot"><b>Usage:</b> this does not use VModel credits. A new ImageKit AI Upscale uses {EXTENSION_UNITS_PER_IMAGE} ImageKit extension units per image ({units} for this selection). ImageKit caches completed AI transformations, and Pixora also reuses successful enhanced URLs when possible.</p>
    </div>
  </div>;
}
