import {
  getVModelToken,
  getVModelTokenByFingerprint,
  unpackVModelTaskId,
  vModelTokenFingerprint,
} from "../../../lib/vmodel-token";
import {
  createStoredResultPreview,
  getStoredResultPreview,
} from "../../../lib/result-preview";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const packedId = requestUrl.searchParams.get("id") || "";
  if (!packedId || !/^[a-zA-Z0-9_-]{6,140}$/.test(packedId)) {
    return Response.json({ error: "Invalid preview ID." }, { status: 400 });
  }

  const unpacked = unpackVModelTaskId(packedId);
  if (!/^[a-zA-Z0-9_-]{6,100}$/.test(unpacked.taskId)) {
    return Response.json({ error: "Invalid preview ID." }, { status: 400 });
  }

  const token = unpacked.fingerprint
    ? await getVModelTokenByFingerprint(unpacked.fingerprint)
    : await getVModelToken();
  if (!token) {
    return Response.json({ error: "The VModel API key for this preview is unavailable." }, { status: 503 });
  }

  const fingerprint = unpacked.fingerprint || vModelTokenFingerprint(token);

  try {
    const existing = await getStoredResultPreview(unpacked.taskId, fingerprint);
    if (existing) {
      return Response.redirect(existing, 307);
    }

    const taskResponse = await fetch(
      `https://api.vmodel.ai/api/tasks/v1/get/${encodeURIComponent(unpacked.taskId)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      },
    );
    const task = await taskResponse.json().catch(() => ({})) as {
      result?: { status?: string; output?: string[]; error?: string };
    };

    if (!taskResponse.ok || task.result?.status !== "succeeded" || !task.result.output?.[0]) {
      return Response.json(
        { error: task.result?.error || "Preview source is not ready." },
        { status: taskResponse.ok ? 409 : 502 },
      );
    }

    const preview = await createStoredResultPreview(
      task.result.output[0],
      unpacked.taskId,
      fingerprint,
      token,
    );
    if (!preview) {
      return Response.json({ error: "Could not prepare browser preview." }, { status: 503 });
    }

    return Response.redirect(preview, 307);
  } catch (error) {
    console.error("Pixora preview route failed", error);
    return Response.json({ error: "Could not prepare browser preview." }, { status: 502 });
  }
}
