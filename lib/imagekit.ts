import { createHmac, randomUUID } from "node:crypto";

const IMAGEKIT_UPLOAD_URL = "https://upload.imagekit.io/api/v1/files/upload";
const IMAGEKIT_API_URL = "https://api.imagekit.io/v1";

export type ImageKitAsset = {
  fileId: string;
  name?: string;
  filePath?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  size?: number;
  tags?: string[];
};

function requiredEnv(name: "IMAGEKIT_PUBLIC_KEY" | "IMAGEKIT_PRIVATE_KEY") {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function privateKey() {
  return requiredEnv("IMAGEKIT_PRIVATE_KEY");
}

function basicAuthorization() {
  return `Basic ${Buffer.from(`${privateKey()}:`, "utf8").toString("base64")}`;
}

async function imageKitApi(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", basicAuthorization());
  headers.set("Accept", "application/json");
  const response = await fetch(`${IMAGEKIT_API_URL}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  return response;
}

export function imageKitConfigured() {
  return Boolean(process.env.IMAGEKIT_PUBLIC_KEY?.trim() && process.env.IMAGEKIT_PRIVATE_KEY?.trim());
}

export function getImageKitUploadAuthentication() {
  const token = randomUUID();
  const expire = Math.floor(Date.now() / 1000) + 30 * 60;
  const signature = createHmac("sha1", privateKey()).update(`${token}${expire}`, "utf8").digest("hex");
  return {
    token,
    expire,
    signature,
    publicKey: requiredEnv("IMAGEKIT_PUBLIC_KEY"),
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT?.trim() || "",
  };
}

export async function uploadImageKitRemoteFile(
  sourceUrl: string,
  fileName: string,
  folder: string,
  tags: string[] = [],
) {
  const body = new FormData();
  body.set("file", sourceUrl);
  body.set("fileName", fileName);
  body.set("folder", folder);
  body.set("useUniqueFileName", "false");
  body.set("overwriteFile", "true");
  if (tags.length) body.set("tags", tags.join(","));

  const response = await fetch(IMAGEKIT_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthorization(),
      Accept: "application/json",
    },
    body,
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({})) as { fileId?: string; url?: string; error?: { message?: string }; message?: string };
  if (!response.ok || !data.fileId || !data.url) {
    throw new Error(data.error?.message || data.message || `ImageKit upload failed (${response.status}).`);
  }
  return { fileId: data.fileId, url: data.url };
}

export async function uploadImageKitData(
  data: string | Buffer,
  fileName: string,
  folder: string,
  contentType = "application/octet-stream",
) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
  const body = new FormData();
  body.set("file", `data:${contentType};base64,${buffer.toString("base64")}`);
  body.set("fileName", fileName);
  body.set("folder", folder);
  body.set("useUniqueFileName", "false");
  body.set("overwriteFile", "true");

  const response = await fetch(IMAGEKIT_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthorization(),
      Accept: "application/json",
    },
    body,
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({})) as { fileId?: string; url?: string; error?: { message?: string }; message?: string };
  if (!response.ok || !result.fileId || !result.url) {
    throw new Error(result.error?.message || result.message || `ImageKit upload failed (${response.status}).`);
  }
  return { fileId: result.fileId, url: result.url, size: buffer.length };
}

export async function listImageKitAssets(path: string, limit = 1000) {
  const params = new URLSearchParams({ path, limit: String(Math.min(1000, Math.max(1, limit))), type: "file", sort: "ASC_CREATED" });
  const response = await imageKitApi(`/files?${params.toString()}`);
  const data = await response.json().catch(() => []) as ImageKitAsset[] | { message?: string };
  if (!response.ok || !Array.isArray(data)) {
    throw new Error(!Array.isArray(data) && data.message ? data.message : `Could not list ImageKit files (${response.status}).`);
  }
  return data;
}

function imageKitSearchValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function findImageKitAssetByName(folder: string, name: string) {
  const normalizedFolder = `/${folder.replace(/^\/+|\/+$/g, "")}/`;
  const searchQuery = `name = "${imageKitSearchValue(name)}" AND path = "${imageKitSearchValue(normalizedFolder)}"`;
  const params = new URLSearchParams({ searchQuery, limit: "1", type: "file" });
  const response = await imageKitApi(`/files?${params.toString()}`);
  const data = await response.json().catch(() => []) as ImageKitAsset[] | { message?: string };
  if (!response.ok || !Array.isArray(data)) {
    throw new Error(!Array.isArray(data) && data.message ? data.message : `Could not find ImageKit file (${response.status}).`);
  }
  return data[0] || null;
}


export async function getImageKitAsset(fileId: string) {
  const response = await imageKitApi(`/files/${encodeURIComponent(fileId)}/details`);
  if (response.status === 404) return null;
  const data = await response.json().catch(() => ({})) as ImageKitAsset & { message?: string };
  if (!response.ok || !data.fileId) throw new Error(data.message || `Could not read ImageKit file (${response.status}).`);
  return data;
}

export async function deleteImageKitFiles(fileIds: string[]) {
  const unique = Array.from(new Set(fileIds.filter((id) => /^[a-zA-Z0-9_-]{6,128}$/.test(id))));
  const deleted: string[] = [];
  for (let index = 0; index < unique.length; index += 100) {
    const batch = unique.slice(index, index + 100);
    const response = await imageKitApi("/files/batch/deleteByFileIds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileIds: batch }),
    });
    const data = await response.json().catch(() => ({})) as { successfullyDeletedFileIds?: string[]; message?: string };
    if (!response.ok) throw new Error(data.message || `Could not delete ImageKit files (${response.status}).`);
    deleted.push(...(data.successfullyDeletedFileIds || batch));
  }
  return deleted;
}

export async function deleteImageKitFilesInFolder(fileIds: string[], allowedFolder: string) {
  const verified: string[] = [];
  for (const fileId of Array.from(new Set(fileIds)).slice(0, 100)) {
    if (!/^[a-zA-Z0-9_-]{6,128}$/.test(fileId)) continue;
    const asset = await getImageKitAsset(fileId);
    if (asset?.filePath?.startsWith(`${allowedFolder.replace(/\/$/, "")}/`)) verified.push(fileId);
  }
  return deleteImageKitFiles(verified);
}

export async function deleteExpiredImageKitFiles(path: string, maxAgeMs: number) {
  const assets = await listImageKitAssets(path, 1000);
  const cutoff = Date.now() - maxAgeMs;
  const expired = assets.filter((asset) => {
    const created = asset.createdAt ? new Date(asset.createdAt).getTime() : Number.NaN;
    return Number.isFinite(created) && created < cutoff;
  });
  if (expired.length) await deleteImageKitFiles(expired.map((asset) => asset.fileId));
  return { remaining: assets.length - expired.length, deleted: expired.length };
}
