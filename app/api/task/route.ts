import { put } from "@vercel/blob";
import { getVModelToken, vModelTokenFingerprint } from "../../../lib/vmodel-token";

function extensionFromType(type: string, imageUrl: URL) {
  if (type.includes("jpeg")) return "jpg";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  if (type.includes("avif")) return "avif";
  const match = imageUrl.pathname.match(/\.(png|jpe?g|webp|gif|avif)$/i);
  return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "png";
}

async function persistGeneratedImage(sourceUrl: string, token: string, taskId: string) {
  const source = new URL(sourceUrl);
  if (source.protocol !== "https:") throw new Error("Generated image URL is not secure.");

  const upstream = await fetch(source, {
    cache: "no-store",
    redirect: "follow",
    headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8" },
  });
  if (!upstream.ok) throw new Error(`Generated image could not be copied (${upstream.status}).`);

  const contentType = upstream.headers.get("content-type") || "image/png";
  if (!contentType.toLowerCase().startsWith("image/")) throw new Error("Generated output was not an image.");

  const blob = await upstream.blob();
  const extension = extensionFromType(contentType, source);
  const stored = await put(`pixora-results/${vModelTokenFingerprint(token)}/${taskId}.${extension}`, blob, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType,
  });
  return stored.url;
}

export async function GET(request: Request) {
  const token = await getVModelToken();
  if (!token) return Response.json({ error: "VModel API is not configured." }, { status: 503 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !/^[a-zA-Z0-9_-]{6,80}$/.test(id)) return Response.json({ error: "Invalid task ID." }, { status: 400 });

  const response = await fetch(`https://api.vmodel.ai/api/tasks/v1/get/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  const data = await response.json() as { result?: { status?: string; output?: string[]; error?: string } };
  if (!response.ok || !data.result) return Response.json({ error: "Could not check generation." }, { status: 502 });

  let output = data.result.output;
  if (data.result.status === "succeeded" && data.result.output?.[0]) {
    const originalOutput = data.result.output[0];
    try {
      const persistedOutput = await persistGeneratedImage(originalOutput, token, id);
      output = [persistedOutput, ...data.result.output.slice(1)];
      await put(`pixora-generations/${vModelTokenFingerprint(token)}/${id}.json`, JSON.stringify({
        taskId: id,
        output: persistedOutput,
        originalOutput,
        completedAt: new Date().toISOString(),
      }), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      });
    } catch (error) {
      console.error("Could not persist Pixora generation", error);
      try {
        await put(`pixora-generations/${vModelTokenFingerprint(token)}/${id}.json`, JSON.stringify({
          taskId: id,
          output: originalOutput,
          completedAt: new Date().toISOString(),
          persistError: error instanceof Error ? error.message : "Unknown persistence error",
        }), {
          access: "public",
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: "application/json",
        });
      } catch (metadataError) {
        console.error("Could not record Pixora generation metadata", metadataError);
      }
    }
  }

  return Response.json({ status: data.result.status, output, error: data.result.error });
}
