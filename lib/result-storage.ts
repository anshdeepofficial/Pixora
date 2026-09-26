import {
  findImageKitAssetByName,
  imageKitConfigured,
  uploadImageKitRemoteFile,
} from "./imagekit";
import {
  getAllVModelTokenContexts,
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
    return {
      url: originalOutput,
      size: 0,
      extension: extensionFromUrl(originalOutput),
      persisted: false,
    };
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

  return {
    url: stored.url,
    size: 0,
    extension,
    persisted: true,
  };
}

async function fetchTaskWithToken(taskId: string, token: string) {
  const response = await fetch(
    `https://api.vmodel.ai/api/tasks/v1/get/${encodeURIComponent(taskId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
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

export async function resolvePackedVModelResult(packedId: string) {
  if (!packedId || !/^[a-zA-Z0-9_-]{6,180}$/.test(packedId)) {
    throw new Error("Invalid result ID.");
  }

  const unpacked = unpackVModelTaskId(packedId);
  if (!/^[a-zA-Z0-9_-]{6,120}$/.test(unpacked.taskId)) {
    throw new Error("Invalid result ID.");
  }

  // First recover from Pixora's persistent store. This must happen before
  // requiring the historical VModel key because old keys may have rotated out.
  if (unpacked.fingerprint) {
    const stored = await findStoredVModelResult(
      unpacked.taskId,
      unpacked.fingerprint,
    );
    if (stored) {
      return {
        ...stored,
        taskId: unpacked.taskId,
        fingerprint: unpacked.fingerprint,
        token: "",
        persisted: true,
      };
    }
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

  // Try every saved key. VModel tasks can remain retrievable after Pixora
  // rotates to a different key, so a missing historical key should not kill
  // the user's download session.
  for (const candidate of candidates) {
    try {
      const output = await fetchTaskWithToken(
        unpacked.taskId,
        candidate.token,
      );
      if (!output) continue;

      // Save recovered output under the historical fingerprint when present.
      // The next retry can then resolve from ImageKit without any VModel key.
      const storageFingerprint =
        unpacked.fingerprint || candidate.fingerprint;
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
      };
    } catch {
      // Try the next saved key.
    }
  }

  // Emergency last resort for expiring sessions: if the full original can no
  // longer be fetched, use Pixora's already-cached browser preview rather than
  // losing the image completely.
  if (imageKitConfigured() && unpacked.fingerprint) {
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

  throw new Error(
    "This result could not be recovered from the available VModel keys.",
  );
}
