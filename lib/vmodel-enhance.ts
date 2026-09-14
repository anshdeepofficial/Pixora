import { getVModelTokenByFingerprint, getVModelTokenContext, packVModelTaskId, unpackVModelTaskId, vModelTokenFingerprint } from "./vmodel-token";

export const GFPGAN_VERSION = "6129309904ce4debfde78de5c209bce0022af40e197e132f08be8ccce3050393";

export type EnhanceScale = 2 | 4;

export async function createEnhancementTask(imageUrl: string, scale: EnhanceScale) {
  const context = await getVModelTokenContext();
  if (!context) throw new Error("No usable VModel API key is available for enhancement.");

  const response = await fetch("https://api.vmodel.ai/api/tasks/v1/create", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${context.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      version: GFPGAN_VERSION,
      input: {
        img: imageUrl,
        version: "v1.4",
        scale,
        disable_safety_checker: false,
      },
    }),
    cache: "no-store",
  });

  const data = await response.json() as {
    code?: number;
    result?: { task_id?: string; task_cost?: number };
    message?: { en?: string } | string;
  };

  const taskId = data.result?.task_id;
  if (!response.ok || !taskId) {
    const message = typeof data.message === "string" ? data.message : data.message?.en;
    throw new Error(message || "VModel could not start image enhancement.");
  }

  return {
    taskId: packVModelTaskId(taskId, context.fingerprint),
    taskCost: data.result?.task_cost,
  };
}

export async function getEnhancementTask(packedId: string) {
  const unpacked = unpackVModelTaskId(packedId);
  if (!/^[a-zA-Z0-9_-]{6,100}$/.test(unpacked.taskId)) throw new Error("Invalid enhancement task ID.");

  const token = unpacked.fingerprint
    ? await getVModelTokenByFingerprint(unpacked.fingerprint)
    : null;
  if (!token) throw new Error("The VModel API key for this enhancement task is no longer available.");

  const fingerprint = unpacked.fingerprint || vModelTokenFingerprint(token);
  const response = await fetch(`https://api.vmodel.ai/api/tasks/v1/get/${encodeURIComponent(unpacked.taskId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  const data = await response.json() as {
    result?: {
      status?: string;
      output?: string[];
      error?: string;
    };
  };

  if (!response.ok || !data.result) throw new Error("Could not check enhancement status.");

  return {
    taskId: unpacked.taskId,
    fingerprint,
    status: data.result.status || "processing",
    output: data.result.output || [],
    error: data.result.error,
  };
}
