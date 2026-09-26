import {
  findImageKitAssetByName,
  imageKitConfigured,
  uploadImageKitRemoteFile,
} from "./imagekit";
import {
  getVModelToken,
  getVModelTokenByFingerprint,
  unpackVModelTaskId,
  vModelTokenFingerprint,
} from "./vmodel-token";

const RESULT_EXTENSIONS = ["png", "webp", "jpg", "jpeg", "avif"] as const;

function resultFolder(fingerprint: string) {
  return `/pixora-results/${fingerprint}`;
}

function extensionFromUrl(value: string) {
  try {
    const pathname = new URL(value).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
    const ext = match?.[1]?.toLowerCase();
    if (ext && RESULT_EXTENSIONS.includes(ext as (typeof RESULT_EXTENSIONS)[number])) return ext;
  } catch {}
  return "png";
}

export function imageKitOriginalUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("imagekit.io")) return url;
    parsed.searchParams.set("tr", "orig-true");
    return parsed.toString();
  } catch {
    return url;
  }
}

export function imageKitPreviewUrl(url: string, width = 1280, quality = 76) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.endsWith("imagekit.io")) return url;
    parsed.searchParams.set(
      "tr",
      `w-${Math.max(320, Math.min(1800, Math.round(width)))},q-${Math.max(55, Math.min(92, Math.round(quality)))}`,
    );
    return parsed.toString();
  } catch {
    return url;
  }
}

export function imageKitAttachmentUrl(url: string, filename: string) {
  try {
    const parsed = new URL(imageKitOriginalUrl(url));
    if (!parsed.hostname.endsWith("imagekit.io")) return url;
    parsed.searchParams.set("ik-attachment", "true");
    parsed.searchParams.set(
      "ik-attachment-filename",
      filename.replace(/\.[a-zA-Z0-9]{2,5}$/i, "").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 100) || "Pixora",
    );
    return parsed.toString();
  } catch {
    return url;
  }
}

export async function findStoredVModelResult(taskId: string, fingerprint: string) {
  if (!imageKitConfigured()) return null;

  for (const extension of RESULT_EXTENSIONS) {
    const asset = await findImageKitAssetByName(resultFolder(fingerprint), `${taskId}.${extension}`);
    if (asset?.url) {
      return {
        url: asset.url,
        size: typeof asset.size === "number" ? asset.size : 0,
        extension,
      };
    }
  }
  return null;
}

export async function persistKnownVModelResult(
  originalOutput: string,
  taskId: string,
  fingerprint: string,
) {
  if (!imageKitConfigured()) {
    return { url: originalOutput, size: 0, extension: extensionFromUrl(originalOutput), persisted: false };
  }

  const existing = await findStoredVModelResult(taskId, fingerprint);
  if (existing) return { ...existing, persisted: true };

  const extension = extensionFromUrl(originalOutput);
  const stored = await uploadImageKitRemoteFile(
    originalOutput,
    `${taskId}.${extension}`,
    resultFolder(fingerprint),
    ["pixora-result", `vmodel-${fingerprint}`],
  );
  return { url: stored.url, size: 0, extension, persisted: true };
}

export async function resolvePackedVModelResult(packedId: string) {
  if (!packedId || !/^[a-zA-Z0-9_-]{6,180}$/.test(packedId)) {
    throw new Error("Invalid result ID.");
  }

  const unpacked = unpackVModelTaskId(packedId);
  if (!/^[a-zA-Z0-9_-]{6,120}$/.test(unpacked.taskId)) {
    throw new Error("Invalid result ID.");
  }

  const token = unpacked.fingerprint
    ? await getVModelTokenByFingerprint(unpacked.fingerprint)
    : await getVModelToken();
  if (!token) throw new Error("The VModel API key for this result is unavailable.");

  const fingerprint = unpacked.fingerprint || vModelTokenFingerprint(token);
  const existing = await findStoredVModelResult(unpacked.taskId, fingerprint);
  if (existing) {
    return {
      ...existing,
      taskId: unpacked.taskId,
      fingerprint,
      token,
      persisted: true,
    };
  }

  const response = await fetch(
    `https://api.vmodel.ai/api/tasks/v1/get/${encodeURIComponent(unpacked.taskId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    },
  );
  const data = await response.json().catch(() => ({})) as {
    result?: { status?: string; output?: string[]; error?: string };
  };

  if (!response.ok || data.result?.status !== "succeeded" || !data.result.output?.[0]) {
    throw new Error(data.result?.error || "The original result is no longer available.");
  }

  const stored = await persistKnownVModelResult(
    data.result.output[0],
    unpacked.taskId,
    fingerprint,
  );

  return {
    ...stored,
    taskId: unpacked.taskId,
    fingerprint,
    token,
  };
}
