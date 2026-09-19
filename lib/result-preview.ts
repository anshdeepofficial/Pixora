import sharp from "sharp";
import {
  findImageKitAssetByName,
  imageKitConfigured,
  uploadImageKitData,
} from "./imagekit";

const PREVIEW_MAX_SOURCE_BYTES = 160 * 1024 * 1024;
const PREVIEW_WIDTH = 1280;
const PREVIEW_QUALITY = 76;

function previewFolder(fingerprint: string) {
  return `/pixora-previews/${fingerprint}`;
}

export async function getStoredResultPreview(taskId: string, fingerprint: string) {
  if (!imageKitConfigured()) return null;
  const asset = await findImageKitAssetByName(previewFolder(fingerprint), `${taskId}.webp`);
  return asset?.url || null;
}

export async function createStoredResultPreview(
  sourceUrl: string,
  taskId: string,
  fingerprint: string,
  token?: string,
) {
  if (!imageKitConfigured()) return null;

  const existing = await getStoredResultPreview(taskId, fingerprint);
  if (existing) return existing;

  const headers = new Headers({ Accept: "image/png,image/jpeg,image/webp,image/*,*/*;q=0.8" });
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(sourceUrl, {
    cache: "no-store",
    redirect: "follow",
    headers,
  });
  if (!response.ok) throw new Error(`Could not fetch generated image for preview (${response.status}).`);

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType && !contentType.startsWith("image/")) {
    throw new Error("Generated output is not an image.");
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > PREVIEW_MAX_SOURCE_BYTES) {
    throw new Error("Generated image is too large to prepare a browser preview.");
  }

  const source = Buffer.from(await response.arrayBuffer());
  if (!source.length) throw new Error("Generated image preview source was empty.");
  if (source.length > PREVIEW_MAX_SOURCE_BYTES) {
    throw new Error("Generated image is too large to prepare a browser preview.");
  }

  const preview = await sharp(source, {
    failOn: "warning",
    limitInputPixels: 120_000_000,
  })
    .rotate()
    .resize({
      width: PREVIEW_WIDTH,
      height: PREVIEW_WIDTH,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({
      quality: PREVIEW_QUALITY,
      effort: 2,
      smartSubsample: true,
    })
    .toBuffer();

  const stored = await uploadImageKitData(
    preview,
    `${taskId}.webp`,
    previewFolder(fingerprint),
    "image/webp",
  );

  return stored.url;
}
