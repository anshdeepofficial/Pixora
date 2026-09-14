import { getVModelToken, vModelTokenFingerprint } from "../../../lib/vmodel-token";
import { imageKitConfigured, uploadImageKitData, uploadImageKitRemoteFile } from "../../../lib/imagekit";

function extensionFromUrl(value: string) {
  try {
    const pathname = new URL(value).pathname;
    const match = pathname.match(/\.(png|jpe?g|webp|gif|avif)$/i);
    return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "png";
  } catch {
    return "png";
  }
}

export async function GET(request: Request) {
  const token = await getVModelToken();
  if (!token) return Response.json({ error: "VModel API is not configured." }, { status: 503 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !/^[a-zA-Z0-9_-]{6,80}$/.test(id)) return Response.json({ error: "Invalid task ID." }, { status: 400 });

  const response = await fetch(`https://api.vmodel.ai/api/tasks/v1/get/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const data = await response.json() as { result?: { status?: string; output?: string[]; error?: string } };
  if (!response.ok || !data.result) return Response.json({ error: "Could not check generation." }, { status: 502 });

  let output = data.result.output;
  let outputFileId: string | undefined;

  if (data.result.status === "succeeded" && data.result.output?.[0] && imageKitConfigured()) {
    const originalOutput = data.result.output[0];
    const fingerprint = vModelTokenFingerprint(token);

    try {
      const extension = extensionFromUrl(originalOutput);
      const persisted = await uploadImageKitRemoteFile(
        originalOutput,
        `${id}.${extension}`,
        `/pixora-results/${fingerprint}`,
        ["pixora-result", `vmodel-${fingerprint}`],
      );
      output = [persisted.url, ...data.result.output.slice(1)];
      outputFileId = persisted.fileId;
    } catch (error) {
      console.error("Could not persist Pixora generation in ImageKit", error);
      output = data.result.output;
    }

    // A task ID is unique, so overwriting this tiny marker makes counting idempotent
    // even though the client polls a succeeded task more than once.
    try {
      await uploadImageKitData(
        JSON.stringify({ taskId: id, completedAt: new Date().toISOString() }),
        `${id}.json`,
        `/pixora-counts/${fingerprint}`,
        "application/json",
      );
    } catch (error) {
      console.error("Could not persist Pixora generation counter marker", error);
    }
  }

  return Response.json({
    status: data.result.status,
    output,
    outputFileId,
    error: data.result.error,
  }, { headers: { "Cache-Control": "no-store" } });
}
