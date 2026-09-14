"use client";

import { useEffect, useRef, useState } from "react";

type DownloadKind = "single" | "separate" | "zip";
type EnhanceScale = 2 | 4;
type PendingDownload = {
  trigger: HTMLButtonElement;
  urls: string[];
  kind: DownloadKind;
  label: string;
};
type ProgressState = {
  percent: number;
  label: string;
  current: number;
  total: number;
};
type UpscalerInstance = {
  upscale: (image: HTMLImageElement | string, options?: {
    patchSize?: number;
    padding?: number;
    awaitNextFrame?: boolean;
    progress?: (progress: number) => void;
  }) => Promise<string>;
  dispose: () => Promise<void>;
};
type UpscalerConstructor = new (options: { model: unknown }) => UpscalerInstance;
type TensorflowBrowser = { ready: () => Promise<void>; getBackend?: () => string };
type FflateFile = { push: (data: Uint8Array, final: boolean) => void };
type FflateZip = { add: (file: FflateFile) => void; end: () => void };
type FflateApi = {
  Zip: new (callback: (error: Error | null, data: Uint8Array, final: boolean) => void) => FflateZip;
  ZipPassThrough: new (name: string) => FflateFile;
};
type PixoraWindow = Window & typeof globalThis & {
  Upscaler?: UpscalerConstructor;
  ESRGANMedium2x?: unknown;
  ESRGANMedium4x?: unknown;
  tf?: TensorflowBrowser;
  fflate?: FflateApi;
};

type ZipWriter = {
  add: (name: string, blob: Blob) => Promise<void>;
  close: () => Promise<Blob>;
};

const TFJS_URL = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js";
const UPSCALER_URL = "https://cdn.jsdelivr.net/npm/upscaler@1.0.0/dist/browser/umd/upscaler.min.js";
const ESRGAN_2X_URL = "https://cdn.jsdelivr.net/npm/@upscalerjs/esrgan-medium@1.0.0/dist/umd/2x.min.js";
const ESRGAN_4X_URL = "https://cdn.jsdelivr.net/npm/@upscalerjs/esrgan-medium@1.0.0/dist/umd/4x.min.js";
const FFLATE_URL = "https://cdn.jsdelivr.net/npm/fflate@0.8.3/umd/index.js";
const ENHANCER_VERSION = "esrgan-medium-1.0.0-pixora-v1";
const CACHE_NAME = "pixora-enhanced-images-v1";
const scriptPromises = new Map<string, Promise<void>>();

function pixoraWindow() {
  return window as PixoraWindow;
}

function uniqueUrls(urls: string[]) {
  return Array.from(new Set(urls.filter(Boolean)));
}

function imageUrl(image?: HTMLImageElement | null) {
  if (!image) return "";
  return image.currentSrc || image.src || "";
}

function outputImageUrls() {
  return uniqueUrls(Array.from(document.querySelectorAll<HTMLImageElement>(".batchOutputGrid article img")).map(imageUrl));
}

function selectedHistoryUrls() {
  return uniqueUrls(Array.from(document.querySelectorAll<HTMLImageElement>(".historyGrid article.selected img")).map(imageUrl));
}

function resolveDownloadAction(button: HTMLButtonElement): Omit<PendingDownload, "trigger"> | null {
  const text = (button.textContent || "").trim().toLowerCase();
  if (button.closest(".downloadSelected")) return null;

  const historyCaption = button.closest(".historyCaption");
  if (historyCaption && (button.getAttribute("aria-label") || "").toLowerCase().includes("download")) {
    const url = imageUrl(historyCaption.closest("article")?.querySelector<HTMLImageElement>("img"));
    return url ? { urls: [url], kind: "single", label: "Download image" } : null;
  }

  const resultActions = button.closest(".resultActions");
  if (resultActions && text.includes("download")) {
    const url = imageUrl(resultActions.closest(".resultCard")?.querySelector<HTMLImageElement>("img"));
    return url ? { urls: [url], kind: "single", label: "Download image" } : null;
  }

  const outputArticle = button.closest(".batchOutputGrid article");
  if (outputArticle && text.includes("download")) {
    const url = imageUrl(outputArticle.querySelector<HTMLImageElement>("img"));
    return url ? { urls: [url], kind: "single", label: "Download batch image" } : null;
  }

  const batchResultActions = button.closest(".batchResultActions");
  if (batchResultActions && text.includes("download")) {
    const card = batchResultActions.closest(".batchCard");
    const readyCards = Array.from(document.querySelectorAll<HTMLElement>(".batchCard")).filter((entry) => entry.querySelector(".batchResultActions"));
    const resultImages = Array.from(document.querySelectorAll<HTMLImageElement>(".batchOutputGrid article img"));
    const index = card ? readyCards.indexOf(card as HTMLElement) : -1;
    const url = index >= 0 ? imageUrl(resultImages[index]) : "";
    return url ? { urls: [url], kind: "single", label: "Download batch image" } : null;
  }

  if (button.closest(".batchOutputHead")) {
    const urls = outputImageUrls();
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

function loadScript(id: string, src: string, ready: () => boolean) {
  if (ready()) return Promise.resolve();
  const current = scriptPromises.get(id);
  if (current) return current;

  const promise = new Promise<void>((resolve, reject) => {
    let script = document.getElementById(id) as HTMLScriptElement | null;
    const timeout = window.setTimeout(() => fail(new Error("AI enhancement model download timed out.")), 90_000);

    function clean() {
      window.clearTimeout(timeout);
      script?.removeEventListener("load", loaded);
      script?.removeEventListener("error", failed);
    }
    function loaded() {
      clean();
      if (ready()) resolve();
      else reject(new Error("An AI enhancement component loaded incorrectly."));
    }
    function failed() {
      clean();
      reject(new Error("Could not download the AI enhancement component."));
    }
    function fail(error: Error) {
      clean();
      reject(error);
    }

    if (script) {
      script.addEventListener("load", loaded, { once: true });
      script.addEventListener("error", failed, { once: true });
      return;
    }

    script = document.createElement("script");
    script.id = id;
    script.src = src;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.referrerPolicy = "no-referrer";
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });
    document.head.appendChild(script);
  });

  const retryable = promise.catch((error) => {
    scriptPromises.delete(id);
    document.getElementById(id)?.remove();
    throw error;
  });
  scriptPromises.set(id, retryable);
  return retryable;
}

async function createEnhancer(scale: EnhanceScale) {
  const target = pixoraWindow();
  await loadScript("pixora-tfjs", TFJS_URL, () => Boolean(target.tf));
  await target.tf?.ready();
  if (scale === 2) {
    await loadScript("pixora-esrgan-2x", ESRGAN_2X_URL, () => Boolean(target.ESRGANMedium2x));
  } else {
    await loadScript("pixora-esrgan-4x", ESRGAN_4X_URL, () => Boolean(target.ESRGANMedium4x));
  }
  await loadScript("pixora-upscaler", UPSCALER_URL, () => Boolean(target.Upscaler));

  if (!target.Upscaler) throw new Error("The AI enhancement engine is unavailable in this browser.");
  const model = scale === 2 ? target.ESRGANMedium2x : target.ESRGANMedium4x;
  if (!model) throw new Error(`The ${scale}× enhancement model did not load.`);
  return new target.Upscaler({ model });
}

async function loadImage(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    if (typeof image.decode === "function") await image.decode();
    else await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not decode this image."));
    });
    return { image, url };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function outputPixelLimit() {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory || 4;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (mobile) return memory <= 4 ? 24_000_000 : 32_000_000;
  return memory <= 4 ? 40_000_000 : 72_000_000;
}

function megapixels(value: number) {
  return Math.round((value / 1_000_000) * 10) / 10;
}

async function fetchSourceBlob(url: string) {
  const params = new URLSearchParams({ url, filename: "pixora-enhance-source", disposition: "inline" });
  const response = await fetch(`/api/download?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) {
    let message = "Could not load this image for enhancement.";
    try {
      const data = await response.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {}
    throw new Error(message);
  }
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("The enhancement source is not a valid image.");
  return blob;
}

async function hashText(value: string) {
  if (crypto.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
  }
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

async function cacheRequest(url: string, scale: EnhanceScale) {
  const key = await hashText(`${ENHANCER_VERSION}|${scale}|${url}`);
  return new Request(`${location.origin}/__pixora_enhance_cache__/${ENHANCER_VERSION}/${scale}/${key}`);
}

async function getCachedEnhanced(url: string, scale: EnhanceScale) {
  if (!("caches" in window)) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(await cacheRequest(url, scale));
    return response ? await response.blob() : null;
  } catch {
    return null;
  }
}

async function putCachedEnhanced(url: string, scale: EnhanceScale, blob: Blob) {
  if (!("caches" in window)) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(await cacheRequest(url, scale), new Response(blob, {
      headers: { "Content-Type": blob.type || "image/png", "Cache-Control": "public, max-age=604800" },
    }));
  } catch {
    // Browser storage can be unavailable or full. Enhancement itself should still succeed.
  }
}

async function enhanceUrl(url: string, scale: EnhanceScale, onProgress: (progress: number, label: string) => void) {
  const cached = await getCachedEnhanced(url, scale);
  if (cached) {
    onProgress(1, "Using cached enhanced image");
    return cached;
  }

  onProgress(0, "Loading source image");
  const source = await fetchSourceBlob(url);
  const loaded = await loadImage(source);
  let enhancer: UpscalerInstance | null = null;
  try {
    const width = loaded.image.naturalWidth || loaded.image.width;
    const height = loaded.image.naturalHeight || loaded.image.height;
    if (!width || !height) throw new Error("Could not read the source image dimensions.");
    const outputPixels = width * height * scale * scale;
    const limit = outputPixelLimit();
    if (outputPixels > limit) {
      throw new Error(`${scale}× would create about ${megapixels(outputPixels)} MP on this device. Choose 2× enhancement or Original to avoid a browser memory crash.`);
    }

    onProgress(0.02, `Loading ${scale}× ESRGAN model`);
    enhancer = await createEnhancer(scale);
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    const patchSize = scale === 4 ? (mobile ? 24 : 32) : (mobile ? 32 : 48);
    const result = await enhancer.upscale(loaded.image, {
      patchSize,
      padding: 4,
      awaitNextFrame: true,
      progress: (value) => onProgress(Math.max(0.03, Math.min(1, value)), `AI restoring detail · ${Math.round(value * 100)}%`),
    });
    const response = await fetch(result);
    if (!response.ok) throw new Error("Could not convert the enhanced image for download.");
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error("The enhancement model returned an invalid image.");
    await putCachedEnhanced(url, scale, blob);
    onProgress(1, "Enhancement complete");
    return blob;
  } finally {
    URL.revokeObjectURL(loaded.url);
    if (enhancer) {
      try { await enhancer.dispose(); } catch {}
    }
  }
}

function saveBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 5000);
}

async function createStreamingZipWriter(): Promise<ZipWriter> {
  const target = pixoraWindow();
  try {
    await loadScript("pixora-fflate", FFLATE_URL, () => Boolean(target.fflate));
  } catch {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    return {
      async add(name, blob) { zip.file(name, blob); },
      async close() { return await zip.generateAsync({ type: "blob", compression: "STORE" }); },
    };
  }

  if (!target.fflate) throw new Error("ZIP support could not be loaded.");
  const chunks: Uint8Array[] = [];
  let resolveArchive: ((value: Blob) => void) | null = null;
  let rejectArchive: ((reason?: unknown) => void) | null = null;
  const archive = new Promise<Blob>((resolve, reject) => {
    resolveArchive = resolve;
    rejectArchive = reject;
  });
  const zip = new target.fflate.Zip((error, data, final) => {
    if (error) {
      rejectArchive?.(error);
      return;
    }
    if (data?.length) chunks.push(data.slice());
    if (final) resolveArchive?.(new Blob(chunks, { type: "application/zip" }));
  });

  return {
    async add(name, blob) {
      const file = new target.fflate!.ZipPassThrough(name);
      zip.add(file);
      file.push(new Uint8Array(await blob.arrayBuffer()), true);
    },
    async close() {
      zip.end();
      return await archive;
    },
  };
}

function closeNativeSelectedMenu() {
  const openMenu = document.querySelector(".downloadMenu");
  if (!openMenu) return;
  const toggle = document.querySelector<HTMLButtonElement>(".downloadSelected");
  toggle?.click();
}

export default function DownloadEnhancementBridge() {
  const bypass = useRef(new WeakSet<HTMLButtonElement>());
  const [pending, setPending] = useState<PendingDownload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<ProgressState>({ percent: 0, label: "", current: 0, total: 0 });

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest("button") as HTMLButtonElement | null;
      if (!button || button.disabled) return;
      if (bypass.current.has(button)) {
        bypass.current.delete(button);
        return;
      }
      const action = resolveDownloadAction(button);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setError("");
      setProgress({ percent: 0, label: "", current: 0, total: action.urls.length });
      setPending({ trigger: button, ...action });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  function downloadOriginal() {
    if (!pending || busy) return;
    const trigger = pending.trigger;
    bypass.current.add(trigger);
    setPending(null);
    setError("");
    window.requestAnimationFrame(() => trigger.click());
  }

  async function downloadEnhanced(scale: EnhanceScale) {
    if (!pending || busy) return;
    const action = pending;
    setBusy(true);
    setError("");
    closeNativeSelectedMenu();
    let zipWriter: ZipWriter | null = null;
    try {
      if (action.kind === "zip") {
        setProgress({ percent: 1, label: "Preparing enhanced ZIP", current: 0, total: action.urls.length });
        zipWriter = await createStreamingZipWriter();
      }

      for (let index = 0; index < action.urls.length; index++) {
        const imageNumber = index + 1;
        const blob = await enhanceUrl(action.urls[index], scale, (local, label) => {
          const percent = ((index + local) / action.urls.length) * 94;
          setProgress({ percent, label: `${label} · ${imageNumber}/${action.urls.length}`, current: imageNumber, total: action.urls.length });
        });
        const name = `pixora-enhanced-${scale}x-${imageNumber}.png`;
        if (zipWriter) await zipWriter.add(name, blob);
        else saveBlob(blob, name);
        setProgress({
          percent: ((index + 1) / action.urls.length) * 94,
          label: `Enhanced ${imageNumber} of ${action.urls.length}`,
          current: imageNumber,
          total: action.urls.length,
        });
      }

      if (zipWriter) {
        setProgress((current) => ({ ...current, percent: 96, label: "Finalizing ZIP archive" }));
        const archive = await zipWriter.close();
        saveBlob(archive, `pixora-enhanced-${scale}x-${action.urls.length}-images.zip`);
      }

      setProgress({ percent: 100, label: `Enhanced download ready · ${action.urls.length} image${action.urls.length === 1 ? "" : "s"}`, current: action.urls.length, total: action.urls.length });
      window.setTimeout(() => {
        setPending(null);
        setBusy(false);
        setProgress({ percent: 0, label: "", current: 0, total: 0 });
      }, 1100);
    } catch (reason) {
      setBusy(false);
      setError(reason instanceof Error ? reason.message : "AI enhancement failed on this device.");
    }
  }

  if (!pending) return null;

  return <div className="pxEnhanceOverlay" role="dialog" aria-modal="true" aria-label="Download quality">
    <style>{`
      .pxEnhanceOverlay{position:fixed;z-index:10000;inset:0;background:rgba(18,20,17,.62);backdrop-filter:blur(8px);display:grid;place-items:center;padding:18px;font-family:var(--font-geist),Arial,sans-serif}
      .pxEnhanceCard{width:min(520px,100%);max-height:calc(100vh - 36px);overflow:auto;background:#fbfaf6;border:1px solid #d8d5cc;border-radius:22px;box-shadow:0 28px 90px rgba(0,0,0,.28);padding:22px;color:#161714}
      .pxEnhanceTop{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:17px}.pxEnhanceTop small{display:block;color:#72756d;font-size:11px;margin-bottom:5px}.pxEnhanceTop h3{margin:0;font:800 20px var(--font-manrope);letter-spacing:-.03em}.pxEnhanceClose{width:34px;height:34px;border:1px solid #d4d1c8;border-radius:50%;background:#fff;color:#555;cursor:pointer;font-size:19px}.pxEnhanceClose:disabled{opacity:.35;cursor:not-allowed}
      .pxEnhanceInfo{display:flex;gap:8px;align-items:center;margin:0 0 14px;padding:10px 12px;border-radius:11px;background:#eef4da;color:#395026;font-size:10px;font-weight:750}.pxEnhanceInfo b{color:#173d2d}
      .pxEnhanceChoices{display:grid;gap:9px}.pxEnhanceChoice{width:100%;display:flex;align-items:center;gap:12px;border:1px solid #d3d0c6;border-radius:14px;background:#fff;padding:13px;text-align:left;cursor:pointer;color:#161714}.pxEnhanceChoice:hover{border-color:#82963e;background:#fbfdf5}.pxEnhanceChoice:disabled{opacity:.55;cursor:not-allowed}.pxEnhanceIcon{width:39px;height:39px;flex:0 0 39px;display:grid;place-items:center;border-radius:10px;background:#f0f0ea;font-weight:900;color:#173d2d}.pxEnhanceChoice.recommended .pxEnhanceIcon{background:#173d2d;color:#c8f04f}.pxEnhanceChoice>span:nth-child(2){min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}.pxEnhanceChoice strong{font-size:12px}.pxEnhanceChoice small{font-size:9px;color:#7d8079;line-height:1.4}.pxEnhanceBadge{font-size:8px;font-weight:900;letter-spacing:.05em;color:#456015;background:#eaf2d1;border-radius:99px;padding:5px 7px;white-space:nowrap}
      .pxEnhanceProgress{margin-top:15px;padding:12px;border:1px solid #d5d2c8;border-radius:12px;background:#f5f4ee}.pxEnhanceProgressTop{display:flex;justify-content:space-between;gap:10px;font-size:10px;color:#666b63;margin-bottom:8px}.pxEnhanceProgressTop strong{color:#173d2d}.pxEnhanceTrack{height:6px;border-radius:99px;background:#dfddd5;overflow:hidden}.pxEnhanceTrack i{height:100%;display:block;background:#73952d;border-radius:inherit;transition:width .18s ease}
      .pxEnhanceError{margin:13px 0 0;padding:11px;border-radius:10px;background:#fff1ec;color:#923c2f;font-size:10px;line-height:1.5}.pxEnhanceErrorActions{display:flex;gap:8px;margin-top:9px}.pxEnhanceErrorActions button{border:1px solid #d5c5bf;border-radius:8px;background:#fff;padding:8px 10px;color:#6e3329;font-size:9px;font-weight:750;cursor:pointer}
      .pxEnhanceFoot{margin:14px 2px 0;color:#898b86;font-size:9px;line-height:1.5}.pxEnhanceFoot b{color:#61655e}
      @media(max-width:560px){.pxEnhanceOverlay{align-items:end;padding:10px}.pxEnhanceCard{border-radius:20px 20px 14px 14px;padding:18px}.pxEnhanceTop h3{font-size:18px}.pxEnhanceChoice{padding:11px}.pxEnhanceBadge{display:none}}
    `}</style>
    <div className="pxEnhanceCard">
      <div className="pxEnhanceTop">
        <div><small>{pending.label} · {pending.urls.length} image{pending.urls.length === 1 ? "" : "s"}</small><h3>Choose download quality</h3></div>
        <button type="button" className="pxEnhanceClose" disabled={busy} onClick={() => setPending(null)} aria-label="Close">×</button>
      </div>

      <p className="pxEnhanceInfo"><b>AI enhancement is free</b><span>Runs on this device · uses 0 VModel credits</span></p>

      <div className="pxEnhanceChoices">
        <button type="button" className="pxEnhanceChoice" disabled={busy} onClick={downloadOriginal}>
          <span className="pxEnhanceIcon">1×</span><span><strong>Original</strong><small>Exactly as V-Editor generated it · fastest</small></span><span className="pxEnhanceBadge">INSTANT</span>
        </button>
        <button type="button" className="pxEnhanceChoice recommended" disabled={busy} onClick={() => void downloadEnhanced(2)}>
          <span className="pxEnhanceIcon">2×</span><span><strong>AI Enhanced HD</strong><small>ESRGAN restores texture and detail while increasing resolution</small></span><span className="pxEnhanceBadge">RECOMMENDED</span>
        </button>
        <button type="button" className="pxEnhanceChoice" disabled={busy} onClick={() => void downloadEnhanced(4)}>
          <span className="pxEnhanceIcon">4×</span><span><strong>AI Enhanced Ultra</strong><small>Maximum resolution and detail · slower and uses more device memory</small></span><span className="pxEnhanceBadge">ULTRA</span>
        </button>
      </div>

      {(busy || progress.percent > 0) && <div className="pxEnhanceProgress" aria-live="polite">
        <div className="pxEnhanceProgressTop"><span>{progress.label || "Preparing AI enhancement"}</span><strong>{Math.round(progress.percent)}%</strong></div>
        <div className="pxEnhanceTrack"><i style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} /></div>
      </div>}

      {error && <div className="pxEnhanceError" role="alert">
        {error}
        <div className="pxEnhanceErrorActions"><button type="button" onClick={downloadOriginal}>Download original instead</button><button type="button" onClick={() => setError("")}>Try another quality</button></div>
      </div>}

      <p className="pxEnhanceFoot"><b>Privacy:</b> the generated image is fetched through Pixora, but AI enhancement itself runs locally in your browser. Enhanced copies are cached on this device so repeated downloads can reuse them without running the model again.</p>
    </div>
  </div>;
}
