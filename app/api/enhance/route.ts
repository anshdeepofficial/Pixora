import { createEnhancementTask, getEnhancementTask, type EnhanceScale } from "../../../lib/vmodel-enhance";
import { imageKitConfigured, uploadImageKitRemoteFile } from "../../../lib/imagekit";

function extensionFromUrl(value: string) {
  try {
    const pathname = new URL(value).pathname;
    const match = pathname.match(/\.(png|jpe?g|webp|gif|avif)$/i);
    return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
  } catch {
    return "jpg";
  }
}

export async function POST(request: Request) {
  const body = await request.json() as { imageUrl?: string; scale?: number };
  const imageUrl = body.imageUrl?.trim() || "";
  const scale: EnhanceScale = body.scale === 4 ? 4 : 2;

  if (!imageUrl.startsWith("https://")) {
    return Response.json({ error: "A valid HTTPS image URL is required." }, { status: 400 });
  }

  try {
    const task = await createEnhancementTask(imageUrl, scale);
    return Response.json({ ...task, scale }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not start enhancement." }, { status: 502 });
  }
}

export async function GET(request: Request) {
  const packedId = new URL(request.url).searchParams.get("id") || "";
  if (!packedId || !/^[a-zA-Z0-9_-]{6,160}$/.test(packedId)) {
    return Response.json({ error: "Invalid enhancement task ID." }, { status: 400 });
  }

  try {
    const task = await getEnhancementTask(packedId);
    let output = task.output;

    if (task.status === "succeeded" && task.output[0] && imageKitConfigured()) {
      try {
        const originalOutput = task.output[0];
        const extension = extensionFromUrl(originalOutput);
        const persisted = await uploadImageKitRemoteFile(
          originalOutput,
          `${task.taskId}.${extension}`,
          `/pixora-enhanced/${task.fingerprint}`,
          ["pixora-enhanced", "gfpgan-v1.4", `vmodel-${task.fingerprint}`],
        );
        output = [persisted.url, ...task.output.slice(1)];
      } catch (error) {
        console.error("Could not persist Pixora enhanced result in ImageKit", error);
      }
    }

    return Response.json({
      status: task.status,
      output,
      error: task.error,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not check enhancement." }, { status: 502 });
  }
}
