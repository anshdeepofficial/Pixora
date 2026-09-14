import { createHash } from "node:crypto";
import { imageKitConfigured, uploadImageKitRemoteFile } from "../../../lib/imagekit";

export const maxDuration = 60;

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

function configuredImageKitHost() {
  const endpoint = process.env.IMAGEKIT_URL_ENDPOINT?.trim();
  if (!endpoint) return "";
  try { return new URL(endpoint).hostname; } catch { return ""; }
}

function isImageKitUrl(value: string) {
  try {
    const host = new URL(value).hostname;
    const configured = configuredImageKitHost();
    return host.endsWith(".imagekit.io") || host === "ik.imagekit.io" || Boolean(configured && host === configured);
  } catch {
    return false;
  }
}

function extensionFromUrl(value: string) {
  try {
    const match = new URL(value).pathname.match(/\.(png|jpe?g|webp|avif)$/i);
    return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "png";
  } catch {
    return "png";
  }
}

async function ensureImageKitSource(imageUrl: string) {
  if (isImageKitUrl(imageUrl)) return imageUrl;

  const probe = await fetch(imageUrl, { cache: "no-store" });
  if (!probe.ok) throw new Error(`Could not load the source image (${probe.status}).`);
  const type = probe.headers.get("content-type") || "";
  if (!type.startsWith("image/")) throw new Error("The source URL did not return an image.");
  const length = Number(probe.headers.get("content-length") || 0);
  if (length > MAX_SOURCE_BYTES) throw new Error("The source image is too large to enhance.");
  try { await probe.body?.cancel(); } catch {}

  const key = createHash("sha256").update(imageUrl).digest("hex").slice(0, 24);
  const persisted = await uploadImageKitRemoteFile(
    imageUrl,
    `enhance-source-${key}.${extensionFromUrl(imageUrl)}`,
    "/pixora-enhance-sources",
    ["pixora-enhance-source"],
  );
  return persisted.url;
}

function imageKitUpscaleUrl(sourceUrl: string) {
  const url = new URL(sourceUrl);
  const existing = url.searchParams.get("tr")?.trim();
  const hasUpscale = existing?.split(":").some((part) => part.split(",").includes("e-upscale"));
  if (!hasUpscale) url.searchParams.set("tr", existing ? `${existing}:e-upscale` : "e-upscale");
  return url.toString();
}

async function checkUpscale(url: string) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,*/*" },
  });

  const intermediate = response.headers.get("is-intermediate-response") === "true";
  if (intermediate) {
    try { await response.body?.cancel(); } catch {}
    return { status: "processing" as const };
  }

  if (!response.ok) {
    const ikError = response.headers.get("ik-error") || "";
    let detail = ikError || `ImageKit AI enhancement failed (${response.status}).`;
    try {
      const text = await response.text();
      if (text && text.length < 500 && !text.trim().startsWith("<")) detail = text;
    } catch {}
    throw new Error(detail);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    try { await response.body?.cancel(); } catch {}
    return { status: "processing" as const };
  }

  try { await response.body?.cancel(); } catch {}
  return { status: "succeeded" as const };
}

export async function POST(request: Request) {
  if (!imageKitConfigured()) {
    return Response.json({ error: "ImageKit must be configured for AI enhancement." }, { status: 503 });
  }

  const body = await request.json() as { imageUrl?: string };
  const imageUrl = body.imageUrl?.trim() || "";
  if (!imageUrl.startsWith("https://")) {
    return Response.json({ error: "A valid HTTPS image URL is required." }, { status: 400 });
  }

  try {
    const sourceUrl = await ensureImageKitSource(imageUrl);
    const outputUrl = imageKitUpscaleUrl(sourceUrl);
    const result = await checkUpscale(outputUrl);

    if (result.status === "processing") {
      return Response.json({
        status: "processing",
        engine: "ImageKit AI Upscale",
      }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }

    return Response.json({
      status: "succeeded",
      output: [outputUrl],
      engine: "ImageKit AI Upscale",
      megapixels: 16,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Server-side AI enhancement failed.",
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
