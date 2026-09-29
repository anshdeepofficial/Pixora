import { put } from "@vercel/blob";
import {
  findImageKitAssetByName,
  findImageKitAssetsByName,
  imageKitConfigured,
  uploadImageKitBinary,
  uploadImageKitRemoteFile,
} from "./imagekit";
import {
  getAllVModelTokenContexts,
  unpackVModelTaskId,
} from "./vmodel-token";

const RESULT_EXTENSIONS = ["png", "webp", "jpg", "jpeg", "avif"] as const;
const IMAGEKIT_SAFE_ORIGINAL_BYTES = 20 * 1024 * 1024;

function resultFolder(fingerprint: string) {
  return `/pixora-results/${fingerprint}`;
}

function extensionFromUrl(value: string) {
  try {
    const pathname = new URL(value).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
    const ext = match?.[1]?.toLowerCase();
    if (ext && RESULT_EXTENSIONS.includes(ext as (typeof RESULT_EXTENSIONS)[number])) {
      return ext === "jpeg" ? "jpg" : ext;
    }
  } catch {}
  return "png";
}

function extensionFromType(contentType: string, sourceUrl: string) {
  const type = contentType.toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("avif")) return "avif";
  return extensionFromUrl(sourceUrl);
}

async function fetchOriginalBinary(sourceUrl: string, token = "") {
  const headers = new Headers({
    Accept: "image/png,image/jpeg,image/webp,image/avif,image/*,*/*;q=0.8",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(sourceUrl, {
    cache: "no-store",
    redirect: "follow",
    headers,
  });
  if (!response.ok) {
    throw new Error(`Generated original could not be fetched (${response.status}).`);
  }

  const contentType = (response.headers.get("content-type") || "image/png").toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new Error("Generated output did not return an image.");
  }

  const data = await response.arrayBuffer();
  if (!data.byteLength) throw new Error("Generated original was empty.");

  return {
    data,
    contentType,
    extension: extensionFromType(contentType, sourceUrl),
  };
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
      filename
        .replace(/\.[a-zA-Z0-9]{2,5}$/i, "")
        .replace(/[^a-zA-Z0-9._-]/g, "-")
        .slice(0, 100) || "Pixora",
    );
    return parsed.toString();
  } catch {
    return url;
  }
}

export async function findStoredVModelResult(taskId: string, fingerprint: string) {
  if (!imageKitConfigured() || !fingerprint) return null;

  for (const extension of RESULT_EXTENSIONS) {
    const asset = await findImageKitAssetByName(
      resultFolder(fingerprint),
      `${taskId}.${extension}`,
    );
    if (asset?.url) {
      return {
        url: asset.url,
        size: typeof asset.size === "number" ? asset.size : 0,
        extension: extension === "jpeg" ? "jpg" : extension,
      };
    }
  }
  return null;
}

async function findStoredVModelResultAnywhere(taskId: string) {
  if (!imageKitConfigured()) return null;

  // Pixora's V-Editor has been configured for PNG originals. Search that exact
  // filename globally first so old results survive API-key/folder rotation.
  const pngMatches = await findImageKitAssetsByName(`${taskId}.png`, 100);
  const png = pngMatches.find((asset) =>
    Boolean(asset.url && asset.filePath?.startsWith("/pixora-results/"))
  );
  if (png?.url) {
    return {
      url: png.url,
      size: typeof png.size === "number" ? png.size : 0,
      extension: "png",
    };
  }

  return null;
}

async function fetchOriginalResponse(sourceUrl: string, token = "") {
  const headers = new Headers({
    Accept: "image/png,image/jpeg,image/webp,image/avif,image/*,*/*;q=0.8",
  });
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(sourceUrl, {
    cache: "no-store",
    redirect: "follow",
    headers,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Generated original could not be fetched (${response.status}).`);
  }

  const contentType = (response.headers.get("content-type") || "image/png").toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new Error("Generated output did not return an image.");
  }

  const size = Number(response.headers.get("content-length") || 0);
  return {
    response,
    body: response.body,
    contentType,
    size: Number.isFinite(size) && size > 0 ? size : 0,
    extension: extensionFromType(contentType, sourceUrl),
  };
}

async function persistOriginalToBlob(
  sourceUrl: string,
  taskId: string,
  fingerprint: string,
  token = "",
) {
  const original = await fetchOriginalResponse(sourceUrl, token);
  const blob = await put(
    `pixora-results/${fingerprint}/${taskId}.${original.extension}`,
    original.body,
    {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: original.contentType,
      multipart: true,
      cacheControlMaxAge: 60 * 60 * 24,
    },
  );

  return {
    url: blob.url,
    downloadUrl: blob.downloadUrl,
    size: original.size,
    extension: original.extension,
    persisted: true,
    storage: "vercel-blob" as const,
  };
}

export async function persistKnownVModelResult(
  originalOutput: string,
  taskId: string,
  fingerprint: string,
  token = "",
) {
  if (imageKitConfigured()) {
    const existing =
      await findStoredVModelResult(taskId, fingerprint) ||
      await findStoredVModelResultAnywhere(taskId);
    if (existing) {
      return {
        ...existing,
        persisted: true,
        storage: "imagekit" as const,
      };
    }
  }

  // Probe the real original once. Large PNGs can exceed ImageKit plan upload
  // limits, so route them to multipart Blob storage instead of losing them.
  let declaredSize = 0;
  try {
    const probe = await fetchOriginalResponse(originalOutput, token);
    declaredSize = probe.size;
    await probe.body.cancel().catch(() => undefined);
  } catch {}

  if (declaredSize > IMAGEKIT_SAFE_ORIGINAL_BYTES) {
    try {
      return await persistOriginalToBlob(
        originalOutput,
        taskId,
        fingerprint,
        token,
      );
    } catch (blobError) {
      console.error("Pixora large-result Blob persistence failed", blobError);
    }
  }

  if (imageKitConfigured()) {
    try {
      const original = await fetchOriginalBinary(originalOutput, token);
      const stored = await uploadImageKitBinary(
        original.data,
        `${taskId}.${original.extension}`,
        resultFolder(fingerprint),
        original.contentType,
        ["pixora-result", "pixora-original", `vmodel-${fingerprint}`],
      );

      return {
        url: stored.url,
        size: stored.size,
        extension: original.extension,
        persisted: true,
        storage: "imagekit" as const,
      };
    } catch (binaryError) {
      console.error("Pixora ImageKit binary persistence failed", binaryError);
    }

    try {
      const extension = extensionFromUrl(originalOutput);
      const stored = await uploadImageKitRemoteFile(
        originalOutput,
        `${taskId}.${extension}`,
        resultFolder(fingerprint),
        ["pixora-result", "pixora-original", `vmodel-${fingerprint}`],
      );

      return {
        url: stored.url,
        size: 0,
        extension,
        persisted: true,
        storage: "imagekit" as const,
      };
    } catch (remoteError) {
      console.error("Pixora ImageKit remote persistence failed", remoteError);
    }
  }

  // If ImageKit rejected a large file and Blob was not tried yet, use multipart
  // Blob as the final durable-storage attempt.
  if (declaredSize <= IMAGEKIT_SAFE_ORIGINAL_BYTES) {
    try {
      return await persistOriginalToBlob(
        originalOutput,
        taskId,
        fingerprint,
        token,
      );
    } catch (blobError) {
      console.error("Pixora Blob persistence fallback failed", blobError);
    }
  }

  // Last resort: return the untouched VModel original so an immediate download
  // still works. This is intentionally not marked persistent.
  return {
    url: originalOutput,
    size: declaredSize,
    extension: extensionFromUrl(originalOutput),
    persisted: false,
    storage: "vmodel" as const,
  };
}

async function fetchTaskWithToken(taskId: string, token = "") {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(
    `https://api.vmodel.ai/api/tasks/v1/get/${encodeURIComponent(taskId)}`,
    {
      headers,
      cache: "no-store",
    },
  );

  const data = await response.json().catch(() => ({})) as {
    result?: { status?: string; output?: string[]; error?: string };
  };

  if (
    response.ok &&
    data.result?.status === "succeeded" &&
    data.result.output?.[0]
  ) {
    return data.result.output[0];
  }
  return null;
}

export async function resolvePackedVModelResult(
  packedId: string,
  options: { allowPreviewFallback?: boolean } = {},
) {
  if (!packedId || !/^[a-zA-Z0-9_-]{6,180}$/.test(packedId)) {
    throw new Error("Invalid result ID.");
  }

  const unpacked = unpackVModelTaskId(packedId);
  if (!/^[a-zA-Z0-9_-]{6,120}$/.test(unpacked.taskId)) {
    throw new Error("Invalid result ID.");
  }

  if (unpacked.fingerprint) {
    const exactStored = await findStoredVModelResult(
      unpacked.taskId,
      unpacked.fingerprint,
    );
    if (exactStored) {
      return {
        ...exactStored,
        taskId: unpacked.taskId,
        fingerprint: unpacked.fingerprint,
        token: "",
        persisted: true,
        fallbackPreview: false,
      };
    }
  }

  // Older Pixora versions may have persisted the original under another
  // fingerprint folder. Recover it globally by task filename.
  const globallyStored = await findStoredVModelResultAnywhere(unpacked.taskId);
  if (globallyStored) {
    return {
      ...globallyStored,
      taskId: unpacked.taskId,
      fingerprint: unpacked.fingerprint,
      token: "",
      persisted: true,
      fallbackPreview: false,
    };
  }

  const allContexts = await getAllVModelTokenContexts();
  const exactContext = unpacked.fingerprint
    ? allContexts.find((item) => item.fingerprint === unpacked.fingerprint)
    : null;

  const candidates: Array<{ token: string; fingerprint: string }> = [];
  if (exactContext) candidates.push(exactContext);
  for (const context of allContexts) {
    if (!candidates.some((item) => item.fingerprint === context.fingerprint)) {
      candidates.push(context);
    }
  }

  for (const candidate of candidates) {
    try {
      const output = await fetchTaskWithToken(unpacked.taskId, candidate.token);
      if (!output) continue;

      const storageFingerprint =
        unpacked.fingerprint || candidate.fingerprint;

      try {
        const stored = await persistKnownVModelResult(
          output,
          unpacked.taskId,
          storageFingerprint,
          candidate.token,
        );
        return {
          ...stored,
          taskId: unpacked.taskId,
          fingerprint: storageFingerprint,
          token: candidate.token,
          fallbackPreview: false,
        };
      } catch {
        // Persistence is preferred, but while the VModel URL is still alive
        // return the untouched original immediately rather than losing it.
        return {
          url: output,
          size: 0,
          extension: extensionFromUrl(output),
          taskId: unpacked.taskId,
          fingerprint: storageFingerprint,
          token: candidate.token,
          persisted: false,
          fallbackPreview: false,
        };
      }
    } catch {
      // Try the next saved key.
    }
  }

  // Some VModel deployments keep completed task metadata readable by task ID
  // even after the creating API key has rotated. Try that once before giving up.
  try {
    const output = await fetchTaskWithToken(unpacked.taskId);
    if (output) {
      const storageFingerprint =
        unpacked.fingerprint || allContexts[0]?.fingerprint || "recovered";
      try {
        const stored = await persistKnownVModelResult(
          output,
          unpacked.taskId,
          storageFingerprint,
          "",
        );
        return {
          ...stored,
          taskId: unpacked.taskId,
          fingerprint: storageFingerprint,
          token: "",
          fallbackPreview: false,
        };
      } catch {
        return {
          url: output,
          size: 0,
          extension: extensionFromUrl(output),
          taskId: unpacked.taskId,
          fingerprint: storageFingerprint,
          token: "",
          persisted: false,
          fallbackPreview: false,
        };
      }
    }
  } catch {}

  if (options.allowPreviewFallback && imageKitConfigured() && unpacked.fingerprint) {
    const preview = await findImageKitAssetByName(
      `/pixora-previews/${unpacked.fingerprint}`,
      `${unpacked.taskId}.webp`,
    );
    if (preview?.url) {
      return {
        url: preview.url,
        size: typeof preview.size === "number" ? preview.size : 0,
        extension: "webp",
        taskId: unpacked.taskId,
        fingerprint: unpacked.fingerprint,
        token: "",
        persisted: true,
        fallbackPreview: true,
      };
    }
  }

  throw new Error("The original generated file could not be recovered.");
}
