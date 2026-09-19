import {
  getVModelToken,
  getVModelTokenByFingerprint,
  maybeRotateVModelTokenAfterGeneration,
  unpackVModelTaskId,
  vModelTokenFingerprint,
} from "../../../lib/vmodel-token";
import { imageKitConfigured, uploadImageKitData } from "../../../lib/imagekit";
import { createStoredResultPreview } from "../../../lib/result-preview";

export async function GET(request: Request) {
  const packedId = new URL(request.url).searchParams.get("id") || "";
  if (!packedId || !/^[a-zA-Z0-9_-]{6,140}$/.test(packedId)) return Response.json({ error: "Invalid task ID." }, { status: 400 });

  const unpacked = unpackVModelTaskId(packedId);
  if (!/^[a-zA-Z0-9_-]{6,100}$/.test(unpacked.taskId)) return Response.json({ error: "Invalid task ID." }, { status: 400 });

  const token = unpacked.fingerprint
    ? await getVModelTokenByFingerprint(unpacked.fingerprint)
    : await getVModelToken();
  if (!token) return Response.json({ error: "The VModel API key for this task is no longer available." }, { status: 503 });

  const fingerprint = unpacked.fingerprint || vModelTokenFingerprint(token);
  const response = await fetch(`https://api.vmodel.ai/api/tasks/v1/get/${encodeURIComponent(unpacked.taskId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const data = await response.json() as { result?: { status?: string; output?: string[]; error?: string } };
  if (!response.ok || !data.result) return Response.json({ error: "Could not check generation." }, { status: 502 });

  const output = data.result.output;
  let previewUrl: string | undefined;
  let downloadUrl: string | undefined;

  if (data.result.status === "succeeded" && data.result.output?.[0]) {
    const originalOutput = data.result.output[0];
    downloadUrl = new URL(`/api/result?id=${encodeURIComponent(packedId)}`, request.url).toString();

    if (imageKitConfigured()) {
      try {
        previewUrl = await createStoredResultPreview(
          originalOutput,
          unpacked.taskId,
          fingerprint,
          token,
        ) || undefined;
      } catch (error) {
        console.error("Could not create lightweight Pixora preview", error);
      }
    }

    // The VModel task ID is unique. Overwriting the same marker keeps the
    // permanent per-API generation counter idempotent across polling retries.
    try {
      await uploadImageKitData(
        JSON.stringify({ taskId: unpacked.taskId, completedAt: new Date().toISOString(), fingerprint }),
        `${unpacked.taskId}.json`,
        `/pixora-counts/${fingerprint}`,
        "application/json",
      );
      await maybeRotateVModelTokenAfterGeneration(fingerprint);
    } catch (error) {
      console.error("Could not persist or rotate Pixora generation counter", error);
    }
  }

  return Response.json({
    status: data.result.status,
    output,
    previewUrl,
    downloadUrl,
    error: data.result.error,
  }, { headers: { "Cache-Control": "no-store" } });
}
