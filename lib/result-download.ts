import sharp from "sharp";
import {
  findImageKitAssetByName,
  imageKitConfigured,
  uploadImageKitData,
} from "./imagekit";

export const DOWNLOAD_MAX_BYTES = 15_000_000;
const DOWNLOAD_TARGET_BYTES = 14_900_000;
const DOWNLOAD_MAX_SOURCE_BYTES = 220 * 1024 * 1024;
const MIN_QUALITY = 48;
const MAX_QUALITY = 96;
const MIN_LONG_EDGE = 1400;

function downloadFolder(fingerprint: string) {
  return `/pixora-downloads/${fingerprint}`;
}

export async function getStoredCompressedResult(taskId: string, fingerprint: string) {
  if (!imageKitConfigured()) return null;
  const asset = await findImageKitAssetByName(downloadFolder(fingerprint), `${taskId}.webp`);
  if (!asset?.url) return null;
  return {
    url: asset.url,
    size: typeof asset.size === "number" ? asset.size : 0,
  };
}

async function encodeWebp(
  source: Buffer,
  quality: number,
  width?: number,
  height?: number,
) {
  let pipeline = sharp(source, {
    failOn: "warning",
    limitInputPixels: 160_000_000,
  }).rotate();

  if (width || height) {
    pipeline = pipeline.resize({
      width,
      height,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  return pipeline
    .webp({
      quality,
      alphaQuality: Math.min(100, quality + 2),
      effort: 3,
      smartSubsample: true,
    })
    .toBuffer();
}

async function bestQualityForSize(
  source: Buffer,
  width?: number,
  height?: number,
) {
  let low = MIN_QUALITY;
  let high = MAX_QUALITY;
  let best: Buffer | null = null;
  let bestQuality = MIN_QUALITY;

  while (low <= high) {
    const quality = Math.floor((low + high) / 2);
    const candidate = await encodeWebp(source, quality, width, height);

    if (candidate.length <= DOWNLOAD_TARGET_BYTES) {
      best = candidate;
      bestQuality = quality;
      low = quality + 1;
    } else {
      high = quality - 1;
    }
  }

  if (best) return { buffer: best, quality: bestQuality };

  const minimum = await encodeWebp(source, MIN_QUALITY, width, height);
  return { buffer: minimum, quality: MIN_QUALITY };
}

export async function compressResultToDownloadLimit(
  source: Buffer,
) {
  if (!source.length) throw new Error("Generated image was empty.");
  if (source.length > DOWNLOAD_MAX_SOURCE_BYTES) {
    throw new Error("Generated image is too large to prepare for download.");
  }

  const metadata = await sharp(source, {
    failOn: "warning",
    limitInputPixels: 160_000_000,
  }).metadata();

  const sourceWidth = metadata.width || 0;
  const sourceHeight = metadata.height || 0;
  if (!sourceWidth || !sourceHeight) {
    throw new Error("Could not read generated image dimensions.");
  }

  // First preserve the model's full dimensions and find the highest WebP quality
  // that stays under the hard 15 MB download ceiling.
  let result = await bestQualityForSize(source);
  if (result.buffer.length <= DOWNLOAD_TARGET_BYTES) {
    return {
      buffer: result.buffer,
      quality: result.quality,
      width: sourceWidth,
      height: sourceHeight,
      resized: false,
    };
  }

  // Extremely detailed/noisy images can exceed 15 MB even at low quality.
  // Reduce dimensions only as much as necessary, then re-run quality search.
  let width = sourceWidth;
  let height = sourceHeight;
  let currentBytes = result.buffer.length;

  for (let attempt = 0; attempt < 8; attempt++) {
    const ratio = Math.min(0.94, Math.sqrt(DOWNLOAD_TARGET_BYTES / Math.max(1, currentBytes)) * 0.97);
    const longEdge = Math.max(width, height);
    const nextLongEdge = Math.max(MIN_LONG_EDGE, Math.floor(longEdge * ratio));

    if (nextLongEdge >= longEdge || longEdge <= MIN_LONG_EDGE) break;

    if (width >= height) {
      width = nextLongEdge;
      height = Math.max(1, Math.round(sourceHeight * (width / sourceWidth)));
    } else {
      height = nextLongEdge;
      width = Math.max(1, Math.round(sourceWidth * (height / sourceHeight)));
    }

    result = await bestQualityForSize(source, width, height);
    currentBytes = result.buffer.length;

    if (currentBytes <= DOWNLOAD_TARGET_BYTES) {
      return {
        buffer: result.buffer,
        quality: result.quality,
        width,
        height,
        resized: width !== sourceWidth || height !== sourceHeight,
      };
    }
  }

  if (result.buffer.length > DOWNLOAD_MAX_BYTES) {
    throw new Error("Could not compress this image below the 15 MB download limit.");
  }

  return {
    buffer: result.buffer,
    quality: result.quality,
    width,
    height,
    resized: width !== sourceWidth || height !== sourceHeight,
  };
}

export async function getOrCreateCompressedResult(
  sourceUrl: string,
  taskId: string,
  fingerprint: string,
  token?: string,
) {
  if (imageKitConfigured()) {
    const existing = await getStoredCompressedResult(taskId, fingerprint);
    if (existing) return { url: existing.url, size: existing.size, created: false };
  }

  const headers = new Headers({ Accept: "image/png,image/jpeg,image/webp,image/*,*/*;q=0.8" });
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(sourceUrl, {
    cache: "no-store",
    redirect: "follow",
    headers,
  });
  if (!response.ok) {
    throw new Error(`Could not fetch original result for compression (${response.status}).`);
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > DOWNLOAD_MAX_SOURCE_BYTES) {
    throw new Error("Generated image is too large to prepare for download.");
  }

  const source = Buffer.from(await response.arrayBuffer());
  const compressed = await compressResultToDownloadLimit(source);

  if (compressed.buffer.length > DOWNLOAD_MAX_BYTES) {
    throw new Error("Compressed download exceeded the 15 MB limit.");
  }

  if (!imageKitConfigured()) {
    return {
      buffer: compressed.buffer,
      size: compressed.buffer.length,
      created: true,
      metadata: compressed,
    };
  }

  const stored = await uploadImageKitData(
    compressed.buffer,
    `${taskId}.webp`,
    downloadFolder(fingerprint),
    "image/webp",
  );

  return {
    url: stored.url,
    size: stored.size,
    created: true,
    metadata: compressed,
  };
}
