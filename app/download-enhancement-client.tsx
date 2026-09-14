// @ts-nocheck
"use client";

import { useEffect, useRef, useState } from "react";

const CACHE_KEY = "pixora-realesrgan-enhance-cache-v1";

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
  try { const value = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); return value && typeof value === "object" ? value : {}; }
  catch { return {}; }
}
function cacheId(url, scale) { return `${scale}x|${url}`; }
function getCachedUrl(url, scale) { return readCache()[cacheId(url, scale)]?.url || ""; }
function rememberEnhancedUrl(sourceUrl, scale, enhancedUrl) {
  try {
    const cache = readCache();
    cache[cacheId(sourceUrl, scale)] = { url: enhancedUrl, savedAt: Date.now() };
    const entries = Object.entries(cache).sort((a, b) => (b[1]?.savedAt || 0) - (a[1]?.savedAt || 0)).slice(0, 200);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

async function enhancedUrl(sourceUrl, scale) {
  const cached = getCachedUrl(sourceUrl, scale);
  if (cached) return { url: cached, cached: true };
  const response = await fetch("/api/enhance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageUrl: sourceUrl, scale }),
  });
  const data = await response.json();
  if (!response.ok || !data.output?.[0]) throw new Error(data.error || "Real-ESRGAN enhancement failed.");
  rememberEnhancedUrl(sourceUrl, scale, data.output[0]);
  return { url: data.output[0], cached: false };
}

async function fetchImageBlob(url) {
  const params = new URLSearchParams({ url, filename: "pixora-enhanced", disposition: "inline" });
  const response = await fetch(`/api/download?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) {
    let detail = "Could not download the enhanced image.";
    try { detail = (await response.json()).error || detail; } catch {}
    throw new Error(detail);
  }
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("The enhancement server returned an invalid image.");
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
  link.href = href; link.download = name; link.style.display = "none";
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 5000);
}
function closeSelectedMenu() {
  if (!document.querySelector(".downloadMenu")) return;
  document.querySelector(".downloadSelected")?.click();
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
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      setError(""); setProgress({ percent: 0, label: "", indeterminate: false });
      setPending({ ...action, trigger: button });
    };
    document.addEventListener("click", capture, true);
    return () => document.removeEventListener("click", capture, true);
  }, []);

  const original = () => {
    if (!pending || busy) return;
    const trigger = pending.trigger;
    bypass.current.add(trigger);
    setPending(null); setError("");
    requestAnimationFrame(() => trigger.click());
  };

  const enhanced = async (scale) => {
    if (!pending || busy) return;
    const action = pending;
    setBusy(true); setError(""); closeSelectedMenu();
    try {
      const zip = action.kind === "zip" ? new (await import("jszip")).default() : null;
      for (let index = 0; index < action.urls.length; index++) {
        const number = index + 1;
        const base = (index / action.urls.length) * 100;
        setProgress({ percent: base, label: `Real-ESRGAN server enhancing · ${number}/${action.urls.length}`, indeterminate: true });
        const result = await enhancedUrl(action.urls[index], scale);
        setProgress({ percent: base, label: result.cached ? `Using saved enhanced result · ${number}/${action.urls.length}` : `Fetching enhanced result · ${number}/${action.urls.length}`, indeterminate: !result.cached });
        const blob = await fetchImageBlob(result.url);
        const name = `pixora-enhanced-${scale}x-${number}.${extensionForBlob(blob)}`;
        if (zip) zip.file(name, blob); else save(blob, name);
        setProgress({ percent: ((index + 1) / action.urls.length) * 100, label: `Enhanced ${number} of ${action.urls.length}`, indeterminate: false });
      }
      if (zip) {
        setProgress({ percent: 100, label: "Creating enhanced ZIP", indeterminate: true });
        const archive = await zip.generateAsync({ type: "blob", compression: "STORE" });
        save(archive, `pixora-realesrgan-${scale}x-${action.urls.length}-images.zip`);
      }
      setProgress({ percent: 100, label: "Enhanced download ready", indeterminate: false });
      setTimeout(() => { setPending(null); setBusy(false); setProgress({ percent: 0, label: "", indeterminate: false }); }, 1000);
    } catch (reason) {
      setBusy(false);
      setProgress((current) => ({ ...current, indeterminate: false }));
      setError(reason instanceof Error ? reason.message : "Server-side Real-ESRGAN enhancement failed.");
    }
  };

  if (!pending) return null;
  return <div className="pxEnhanceOverlay" role="dialog" aria-modal="true" aria-label="Download quality">
    <style>{`
      .pxEnhanceOverlay{position:fixed;z-index:10000;inset:0;background:rgba(18,20,17,.64);backdrop-filter:blur(8px);display:grid;place-items:center;padding:18px;font-family:var(--font-geist),Arial,sans-serif}.pxEnhanceCard{width:min(520px,100%);max-height:calc(100vh - 36px);overflow:auto;background:#fbfaf6;border:1px solid #d8d5cc;border-radius:22px;box-shadow:0 28px 90px rgba(0,0,0,.28);padding:22px;color:#161714}.pxEnhanceTop{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:17px}.pxEnhanceTop small{display:block;color:#72756d;font-size:11px;margin-bottom:5px}.pxEnhanceTop h3{margin:0;font:800 20px var(--font-manrope);letter-spacing:-.03em}.pxEnhanceClose{width:34px;height:34px;border:1px solid #d4d1c8;border-radius:50%;background:#fff;color:#555;cursor:pointer;font-size:19px}.pxEnhanceClose:disabled{opacity:.35}.pxEnhanceInfo{display:flex;gap:7px;align-items:center;margin:0 0 14px;padding:10px 12px;border-radius:11px;background:#eef4da;color:#395026;font-size:10px;font-weight:750}.pxEnhanceChoices{display:grid;gap:9px}.pxEnhanceChoice{width:100%;display:flex;align-items:center;gap:12px;border:1px solid #d3d0c6;border-radius:14px;background:#fff;padding:13px;text-align:left;cursor:pointer;color:#161714}.pxEnhanceChoice:hover{border-color:#82963e;background:#fbfdf5}.pxEnhanceChoice:disabled{opacity:.55;cursor:not-allowed}.pxEnhanceIcon{width:39px;height:39px;flex:0 0 39px;display:grid;place-items:center;border-radius:10px;background:#f0f0ea;font-weight:900;color:#173d2d}.pxEnhanceChoice.recommended .pxEnhanceIcon{background:#173d2d;color:#c8f04f}.pxEnhanceChoice>span:nth-child(2){min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}.pxEnhanceChoice strong{font-size:12px}.pxEnhanceChoice small{font-size:9px;color:#7d8079;line-height:1.4}.pxEnhanceBadge{font-size:8px;font-weight:900;color:#456015;background:#eaf2d1;border-radius:99px;padding:5px 7px;white-space:nowrap}.pxEnhanceProgress{margin-top:15px;padding:12px;border:1px solid #d5d2c8;border-radius:12px;background:#f5f4ee}.pxEnhanceProgressTop{display:flex;justify-content:space-between;gap:10px;font-size:10px;color:#666b63;margin-bottom:8px}.pxEnhanceTrack{height:6px;border-radius:99px;background:#dfddd5;overflow:hidden}.pxEnhanceTrack i{height:100%;display:block;background:#73952d;border-radius:inherit;transition:width .18s ease}.pxEnhanceTrack.indeterminate i{width:36%!important;animation:pxEnhanceSweep 1.1s ease-in-out infinite}.pxEnhanceError{margin:13px 0 0;padding:11px;border-radius:10px;background:#fff1ec;color:#923c2f;font-size:10px;line-height:1.5}.pxEnhanceError button{margin-top:8px;border:1px solid #d5c5bf;border-radius:8px;background:#fff;padding:8px 10px;color:#6e3329;font-size:9px;font-weight:750;cursor:pointer}.pxEnhanceFoot{margin:14px 2px 0;color:#898b86;font-size:9px;line-height:1.5}.pxEnhanceFoot b{color:#61655e}@keyframes pxEnhanceSweep{0%{transform:translateX(-120%)}50%{transform:translateX(110%)}100%{transform:translateX(280%)}}@media(max-width:560px){.pxEnhanceOverlay{align-items:end;padding:10px}.pxEnhanceCard{border-radius:20px 20px 14px 14px;padding:18px}.pxEnhanceBadge{display:none}}
    `}</style>
    <div className="pxEnhanceCard">
      <div className="pxEnhanceTop"><div><small>{pending.label} · {pending.urls.length} image{pending.urls.length === 1 ? "" : "s"}</small><h3>Choose download quality</h3></div><button type="button" className="pxEnhanceClose" disabled={busy} onClick={() => setPending(null)} aria-label="Close">×</button></div>
      <p className="pxEnhanceInfo"><b>Remote AI enhancement</b><span>Real-ESRGAN runs on a separate server · no VModel enhancement</span></p>
      <div className="pxEnhanceChoices">
        <button type="button" className="pxEnhanceChoice" disabled={busy} onClick={original}><span className="pxEnhanceIcon">1×</span><span><strong>Original</strong><small>Exactly as generated · no enhancement</small></span><span className="pxEnhanceBadge">INSTANT</span></button>
        <button type="button" className="pxEnhanceChoice recommended" disabled={busy} onClick={() => enhanced(2)}><span className="pxEnhanceIcon">2×</span><span><strong>Real-ESRGAN HD</strong><small>Server-side 2× detail restoration and upscaling</small></span><span className="pxEnhanceBadge">RECOMMENDED</span></button>
        <button type="button" className="pxEnhanceChoice" disabled={busy} onClick={() => enhanced(4)}><span className="pxEnhanceIcon">4×</span><span><strong>Real-ESRGAN Ultra</strong><small>Server-side 4× upscale · heavier but keeps your phone light</small></span><span className="pxEnhanceBadge">ULTRA</span></button>
      </div>
      {(busy || progress.percent > 0) && <div className="pxEnhanceProgress" aria-live="polite"><div className="pxEnhanceProgressTop"><span>{progress.label || "Preparing enhancement"}</span><strong>{Math.round(progress.percent)}%</strong></div><div className={`pxEnhanceTrack ${progress.indeterminate ? "indeterminate" : ""}`}><i style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} /></div></div>}
      {error && <div className="pxEnhanceError" role="alert">{error}<br/><button type="button" onClick={original}>Download original instead</button></div>}
      <p className="pxEnhanceFoot"><b>Privacy:</b> enhancement is processed remotely by Real-ESRGAN and the finished result is saved to Pixora's ImageKit storage. It does not use your VModel API key or increase your V-Editor generation count.</p>
    </div>
  </div>;
}
