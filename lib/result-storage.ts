import {
  findImageKitAssetByName,
  findImageKitAssetsByName,
  imageKitConfigured,
  uploadImageKitRemoteFile,
} from "./imagekit";
import {
  getAllVModelTokenContexts,
  unpackVModelTaskId,
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
    if (ext && RESULT_EXTENSIONS.includes(ext as (typeof RESULT_EXTENSIONS)[number])) {
      return ext === "jpeg" ? "jpg" : ext;
    }
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

export async function persistKnownVModelResult(
  originalOutput: string,
  taskId: string,
  fingerprint: string,
) {
  if (!imageKitConfigured()) {
    return {
      url: originalOutput,
      size: 0,
      extension: extensionFromUrl(originalOutput),
      persisted: false,
    };
  }

  const existing =
    await findStoredVModelResult(taskId, fingerprint) ||
    await findStoredVModelResultAnywhere(taskId);
  if (existing) return { ...existing, persisted: true };

  const extension = extensionFromUrl(originalOutput);
  const stored = await uploadImageKitRemoteFile(
    originalOutput,
    `${taskId}.${extension}`,
    resultFolder(fingerprint),
    ["pixora-result", `vmodel-${fingerprint}`],
  );

  return {
    url: stored.url,
    size: 0,
    extension,
    persisted: true,
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
