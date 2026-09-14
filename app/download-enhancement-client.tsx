// @ts-nocheck
"use client";

import { useEffect, useRef, useState } from "react";

const TFJS_URL = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js";
const UPSCALER_URL = "https://cdn.jsdelivr.net/npm/upscaler@1.0.0/dist/browser/umd/upscaler.min.js";
const ESRGAN_2X_URL = "https://cdn.jsdelivr.net/npm/@upscalerjs/esrgan-medium@1.0.0/dist/umd/2x.min.js";
const ESRGAN_4X_URL = "https://cdn.jsdelivr.net/npm/@upscalerjs/esrgan-medium@1.0.0/dist/umd/4x.min.js";
const FFLATE_URL = "https://cdn.jsdelivr.net/npm/fflate@0.8.3/umd/index.js";
const CACHE_NAME = "pixora-ai-enhance-v1";
const MODEL_VERSION = "esrgan-medium-1.0.0";
const scriptLoads = new Map();

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function imgSrc(img) {
  return img?.currentSrc || img?.src || "";
}

function selectedHistoryUrls() {
  return unique(Array.from(document.querySelectorAll(".historyGrid article.selected img")).map(imgSrc));
}

function batchOutputUrls() {
  return unique(Array.from(document.querySelectorAll(".batchOutputGrid article img")).map(imgSrc));
}

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

function loadScript(id, src, ready) {
  if (ready()) return Promise.resolve();
  if (scriptLoads.has(id)) return scriptLoads.get(id);

  const promise = new Promise((resolve, reject) => {
    let script = document.getElementById(id);
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      script?.removeEventListener("load", onLoad);
      script?.removeEventListener("error", onError);
    };
    const onLoad = () => {
      cleanup();
      ready() ? resolve() : reject(new Error("An enhancement component loaded incorrectly."));
    };
    const onError = () => {
      cleanup();
      reject(new Error("Could not download the AI enhancement component."));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("AI enhancement model download timed out."));
    }, 90000);

    if (script) {
      script.addEventListener("load", onLoad, { once: true });
      script.addEventListener("error", onError, { once: true });
      return;
    }

    script = document.createElement("script");
    script.id = id;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.referrerPolicy = "no-referrer";
    script.src = src;
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    document.head.appendChild(script);
  }).catch((error) => {
    scriptLoads.delete(id);
    document.getElementById(id)?.remove();
    throw error;
  });

  scriptLoads.set(id, promise);
  return promise;
}

async function createUpscaler(scale) {
  await loadScript("px-tfjs", TFJS_URL, () => Boolean(window.tf));
  await window.tf.ready();
  if (scale === 4) await loadScript("px-esrgan-4", ESRGAN_4X_URL, () => Boolean(window.ESRGANMedium4x));
  else await loadScript("px-esrgan-2", ESRGAN_2X_URL, () => Boolean(window.ESRGANMedium2x));
  await loadScript("px-upscaler", UPSCALER_URL, () => Boolean(window.Upscaler));
  if (!window.Upscaler) throw new Error("AI enhancement is not supported in this browser.");
  const model = scale === 4 ? window.ESRGANMedium4x : window.ESRGANMedium2x;
  if (!model) throw new Error(`${scale}× enhancement model did not load.`);
  return new window.Upscaler({ model });
}

async function sourceBlob(url) {
  const params = new URLSearchParams({ url, filename: "pixora-enhance-source", disposition: "inline" });
  const response = await fetch(`/api/download?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) {
    let detail = "Could not load this image for enhancement.";
    try { detail = (await response.json()).error || detail; } catch {}
    throw new Error(detail);
  }
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("The source is not a valid image.");
  return blob;
}

async function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    if (image.decode) await image.decode();
    else await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
    return { image, url };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function pixelLimit() {
  const memory = navigator.deviceMemory || 4;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (mobile) return memory <= 4 ? 24000000 : 32000000;
  return memory <= 4 ? 40000000 : 72000000;
}

async function cacheKey(url, scale) {
  const input = new TextEncoder().encode(`${MODEL_VERSION}|${scale}|${url}`);
  let key = "";
  try {
    const digest = await crypto.subtle.digest("SHA-256", input);
    key = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
  } catch {
    key = btoa(unescape(encodeURIComponent(url))).replace(/[^a-z0-9]/gi, "").slice(-32);
  }
  return new Request(`${location.origin}/__pixora_enhance_cache__/${MODEL_VERSION}/${scale}/${key}`);
}

async function cached(url, scale) {
  if (!("caches" in window)) return null;
  try {
    const response = await (await caches.open(CACHE_NAME)).match(await cacheKey(url, scale));
    return response ? await response.blob() : null;
  } catch { return null; }
}

async function remember(url, scale, blob) {
  if (!("caches" in window)) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(await cacheKey(url, scale), new Response(blob, { headers: { "Content-Type": blob.type || "image/png" } }));
  } catch {}
}

async function enhance(url, scale, progress) {
  const hit = await cached(url, scale);
  if (hit) { progress(1, "Using cached enhanced image"); return hit; }

  progress(0, "Loading source image");
  const loaded = await loadImage(await sourceBlob(url));
  let upscaler;
  try {
    const width = loaded.image.naturalWidth || loaded.image.width;
    const height = loaded.image.naturalHeight || loaded.image.height;
    const outputPixels = width * height * scale * scale;
    if (!width || !height) throw new Error("Could not read image dimensions.");
    if (outputPixels > pixelLimit()) {
      const mp = Math.round(outputPixels / 100000) / 10;
      throw new Error(`${scale}× would create about ${mp} MP on this device. Choose 2× or Original to avoid a memory crash.`);
    }

    progress(.02, `Loading ${scale}× ESRGAN model`);
    upscaler = await createUpscaler(scale);
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    const result = await upscaler.upscale(loaded.image, {
      patchSize: scale === 4 ? (mobile ? 24 : 32) : (mobile ? 32 : 48),
      padding: 4,
      awaitNextFrame: true,
      progress: (value) => progress(Math.max(.03, Math.min(1, value)), `AI restoring detail · ${Math.round(value * 100)}%`),
    });
    const blob = await (await fetch(result)).blob();
    if (!blob.type.startsWith("image/")) throw new Error("The enhancement model returned an invalid image.");
    await remember(url, scale, blob);
    progress(1, "Enhancement complete");
    return blob;
  } finally {
    URL.revokeObjectURL(loaded.url);
    try { await upscaler?.dispose?.(); } catch {}
  }
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

async function zipWriter() {
  await loadScript("px-fflate", FFLATE_URL, () => Boolean(window.fflate));
  if (!window.fflate) throw new Error("ZIP support could not load.");
  const chunks = [];
  let resolveArchive;
  let rejectArchive;
  const archive = new Promise((resolve, reject) => { resolveArchive = resolve; rejectArchive = reject; });
  const zip = new window.fflate.Zip((error, data, final) => {
    if (error) { rejectArchive(error); return; }
    if (data?.length) chunks.push(data.slice());
    if (final) resolveArchive(new Blob(chunks, { type: "application/zip" }));
  });
  return {
    async add(name, blob) {
      const file = new window.fflate.ZipPassThrough(name);
      zip.add(file);
      file.push(new Uint8Array(await blob.arrayBuffer()), true);
    },
    async close() { zip.end(); return await archive; },
  };
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
  const [progress, setProgress] = useState({ percent: 0, label: "" });

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
      setProgress({ percent: 0, label: "" });
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

  const enhanced = async (scale) => {
    if (!pending || busy) return;
    const action = pending;
    setBusy(true);
    setError("");
    closeSelectedMenu();
    let writer = null;
    try {
      if (action.kind === "zip") writer = await zipWriter();
      for (let index = 0; index < action.urls.length; index++) {
        const number = index + 1;
        const blob = await enhance(action.urls[index], scale, (local, label) => {
          setProgress({ percent: ((index + local) / action.urls.length) * 95, label: `${label} · ${number}/${action.urls.length}` });
        });
        const name = `pixora-enhanced-${scale}x-${number}.png`;
        if (writer) await writer.add(name, blob);
        else save(blob, name);
      }
      if (writer) {
        setProgress({ percent: 97, label: "Finalizing ZIP archive" });
        save(await writer.close(), `pixora-enhanced-${scale}x-${action.urls.length}-images.zip`);
      }
      setProgress({ percent: 100, label: "Enhanced download ready" });
      setTimeout(() => { setPending(null); setBusy(false); setProgress({ percent: 0, label: "" }); }, 900);
    } catch (reason) {
      setBusy(false);
      setError(reason instanceof Error ? reason.message : "AI enhancement failed on this device.");
    }
  };

  if (!pending) return null;

  return <div className="pxEnhanceOverlay" role="dialog" aria-modal="true" aria-label="Download quality">
    <style>{`
      .pxEnhanceOverlay{position:fixed;z-index:10000;inset:0;background:rgba(18,20,17,.64);backdrop-filter:blur(8px);display:grid;place-items:center;padding:18px;font-family:var(--font-geist),Arial,sans-serif}.pxEnhanceCard{width:min(520px,100%);max-height:calc(100vh - 36px);overflow:auto;background:#fbfaf6;border:1px solid #d8d5cc;border-radius:22px;box-shadow:0 28px 90px rgba(0,0,0,.28);padding:22px;color:#161714}.pxEnhanceTop{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:17px}.pxEnhanceTop small{display:block;color:#72756d;font-size:11px;margin-bottom:5px}.pxEnhanceTop h3{margin:0;font:800 20px var(--font-manrope);letter-spacing:-.03em}.pxEnhanceClose{width:34px;height:34px;border:1px solid #d4d1c8;border-radius:50%;background:#fff;color:#555;cursor:pointer;font-size:19px}.pxEnhanceClose:disabled{opacity:.35}.pxEnhanceInfo{display:flex;gap:7px;align-items:center;margin:0 0 14px;padding:10px 12px;border-radius:11px;background:#eef4da;color:#395026;font-size:10px;font-weight:750}.pxEnhanceChoices{display:grid;gap:9px}.pxEnhanceChoice{width:100%;display:flex;align-items:center;gap:12px;border:1px solid #d3d0c6;border-radius:14px;background:#fff;padding:13px;text-align:left;cursor:pointer;color:#161714}.pxEnhanceChoice:hover{border-color:#82963e;background:#fbfdf5}.pxEnhanceChoice:disabled{opacity:.55;cursor:not-allowed}.pxEnhanceIcon{width:39px;height:39px;flex:0 0 39px;display:grid;place-items:center;border-radius:10px;background:#f0f0ea;font-weight:900;color:#173d2d}.pxEnhanceChoice.recommended .pxEnhanceIcon{background:#173d2d;color:#c8f04f}.pxEnhanceChoice>span:nth-child(2){min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}.pxEnhanceChoice strong{font-size:12px}.pxEnhanceChoice small{font-size:9px;color:#7d8079;line-height:1.4}.pxEnhanceBadge{font-size:8px;font-weight:900;color:#456015;background:#eaf2d1;border-radius:99px;padding:5px 7px;white-space:nowrap}.pxEnhanceProgress{margin-top:15px;padding:12px;border:1px solid #d5d2c8;border-radius:12px;background:#f5f4ee}.pxEnhanceProgressTop{display:flex;justify-content:space-between;gap:10px;font-size:10px;color:#666b63;margin-bottom:8px}.pxEnhanceTrack{height:6px;border-radius:99px;background:#dfddd5;overflow:hidden}.pxEnhanceTrack i{height:100%;display:block;background:#73952d;border-radius:inherit;transition:width .18s ease}.pxEnhanceError{margin:13px 0 0;padding:11px;border-radius:10px;background:#fff1ec;color:#923c2f;font-size:10px;line-height:1.5}.pxEnhanceError button{margin-top:8px;border:1px solid #d5c5bf;border-radius:8px;background:#fff;padding:8px 10px;color:#6e3329;font-size:9px;font-weight:750;cursor:pointer}.pxEnhanceFoot{margin:14px 2px 0;color:#898b86;font-size:9px;line-height:1.5}.pxEnhanceFoot b{color:#61655e}@media(max-width:560px){.pxEnhanceOverlay{align-items:end;padding:10px}.pxEnhanceCard{border-radius:20px 20px 14px 14px;padding:18px}.pxEnhanceBadge{display:none}}
    `}</style>
    <div className="pxEnhanceCard">
      <div className="pxEnhanceTop"><div><small>{pending.label} · {pending.urls.length} image{pending.urls.length === 1 ? "" : "s"}</small><h3>Choose download quality</h3></div><button type="button" className="pxEnhanceClose" disabled={busy} onClick={() => setPending(null)} aria-label="Close">×</button></div>
      <p className="pxEnhanceInfo"><b>Free AI enhancement</b><span>Runs on your device · 0 VModel credits</span></p>
      <div className="pxEnhanceChoices">
        <button type="button" className="pxEnhanceChoice" disabled={busy} onClick={original}><span className="pxEnhanceIcon">1×</span><span><strong>Original</strong><small>Exactly as generated · fastest</small></span><span className="pxEnhanceBadge">INSTANT</span></button>
        <button type="button" className="pxEnhanceChoice recommended" disabled={busy} onClick={() => enhanced(2)}><span className="pxEnhanceIcon">2×</span><span><strong>AI Enhanced HD</strong><small>ESRGAN restores texture and detail while increasing resolution</small></span><span className="pxEnhanceBadge">RECOMMENDED</span></button>
        <button type="button" className="pxEnhanceChoice" disabled={busy} onClick={() => enhanced(4)}><span className="pxEnhanceIcon">4×</span><span><strong>AI Enhanced Ultra</strong><small>Maximum detail · slower and heavier on phones</small></span><span className="pxEnhanceBadge">ULTRA</span></button>
      </div>
      {(busy || progress.percent > 0) && <div className="pxEnhanceProgress" aria-live="polite"><div className="pxEnhanceProgressTop"><span>{progress.label || "Preparing enhancement"}</span><strong>{Math.round(progress.percent)}%</strong></div><div className="pxEnhanceTrack"><i style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} /></div></div>}
      {error && <div className="pxEnhanceError" role="alert">{error}<br/><button type="button" onClick={original}>Download original instead</button></div>}
      <p className="pxEnhanceFoot"><b>Privacy:</b> enhancement runs locally in the browser. Enhanced versions are cached on this device so repeat downloads can reuse them without rerunning the model.</p>
    </div>
  </div>;
}
