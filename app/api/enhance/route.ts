import { createHash } from "node:crypto";
import { imageKitConfigured, uploadImageKitData } from "../../../lib/imagekit";

export const maxDuration = 120;

const DEFAULT_ENHANCER_URL = "https://itishanls249-real-esrgan-upscaler.hf.space";
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

function enhancerBaseUrl() {
  return (process.env.PIXORA_ENHANCER_URL?.trim() || DEFAULT_ENHANCER_URL).replace(/\/+$/, "");
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForEnhancer(baseUrl: string) {
  for (let attempt = 0; attempt < 18; attempt++) {
    try {
      const response = await fetchWithTimeout(`${baseUrl}/health`, {}, 8_000);
      if (response.ok) {
        const data = await response.json().catch(() => ({})) as { status?: string; models_loaded?: boolean; models_error?: string | null };
        if (data.models_loaded || data.status === "healthy") return;
        if (data.models_error) throw new Error(data.models_error);
      }
    } catch (error) {
      if (attempt === 17) throw error;
    }
    await wait(1_500);
  }
  throw new Error("The enhancement server is still warming up. Please try again in a moment.");
}

async function sourceImage(imageUrl: string) {
  const response = await fetchWithTimeout(imageUrl, {}, 30_000);
  if (!response.ok) throw new Error(`Could not load the source image (${response.status}).`);
  const contentType = response.headers.get("content-type") || "image/png";
  if (!contentType.startsWith("image/")) throw new Error("The source URL did not return an image.");
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length) throw new Error("The source image is empty.");
  if (data.length > MAX_SOURCE_BYTES) throw new Error("The source image is too large to enhance.");
  return { data, contentType };
}

async function runEnhancer(baseUrl: string, image: Buffer, contentType: string, scale: 2 | 4) {
  const form = new FormData();
  form.set("file", new Blob([image], { type: contentType }), `pixora-source.${contentType.includes("jpeg") ? "jpg" : "png"}`);
  form.set("scale", String(scale));

  let response = await fetchWithTimeout(`${baseUrl}/image_enhancer`, { method: "POST", body: form }, 95_000);
  if (response.status === 503) {
    await waitForEnhancer(baseUrl);
    response = await fetchWithTimeout(`${baseUrl}/image_enhancer`, { method: "POST", body: form }, 95_000);
  }

  if (!response.ok) {
    let detail = `Enhancement server failed (${response.status}).`;
    try {
      const data = await response.json() as { detail?: string };
      if (data.detail) detail = data.detail;
    } catch {}
    throw new Error(detail);
  }

  const contentTypeOut = response.headers.get("content-type") || "image/png";
  if (!contentTypeOut.startsWith("image/")) throw new Error("The enhancement server returned an invalid response.");
  const output = Buffer.from(await response.arrayBuffer());
  if (!output.length) throw new Error("The enhancement server returned an empty image.");
  return { output, contentType: contentTypeOut };
}

export async function POST(request: Request) {
  const body = await request.json() as { imageUrl?: string; scale?: number };
  const imageUrl = body.imageUrl?.trim() || "";
  const scale: 2 | 4 = body.scale === 4 ? 4 : 2;

  if (!imageUrl.startsWith("https://")) {
    return Response.json({ error: "A valid HTTPS image URL is required." }, { status: 400 });
  }
  if (!imageKitConfigured()) {
    return Response.json({ error: "ImageKit must be configured to save enhanced images." }, { status: 503 });
  }

  try {
    const baseUrl = enhancerBaseUrl();
    await waitForEnhancer(baseUrl);
    const source = await sourceImage(imageUrl);
    const enhanced = await runEnhancer(baseUrl, source.data, source.contentType, scale);
    const key = createHash("sha256").update(`${imageUrl}|${scale}|realesrgan`).digest("hex").slice(0, 24);
    const persisted = await uploadImageKitData(
      enhanced.output,
      `realesrgan-${scale}x-${key}.png`,
      "/pixora-enhanced/realesrgan",
      enhanced.contentType,
    );

    return Response.json({
      status: "succeeded",
      output: [persisted.url],
      scale,
      engine: "Real-ESRGAN",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Server-side image enhancement failed.";
    const timeout = /abort|timeout|warming up/i.test(message);
    return Response.json({ error: message }, { status: timeout ? 504 : 502 });
  }
}
