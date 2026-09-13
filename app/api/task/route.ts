import { put } from "@vercel/blob";
import { getVModelToken, vModelTokenFingerprint } from "../../../lib/vmodel-token";

export async function GET(request: Request) {
  const token = await getVModelToken();
  if (!token) return Response.json({ error: "VModel API is not configured." }, { status: 503 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !/^[a-zA-Z0-9_-]{6,80}$/.test(id)) return Response.json({ error: "Invalid task ID." }, { status: 400 });

  const response = await fetch(`https://api.vmodel.ai/api/tasks/v1/get/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  const data = await response.json() as { result?: { status?: string; output?: string[]; error?: string } };
  if (!response.ok || !data.result) return Response.json({ error: "Could not check generation." }, { status: 502 });

  if (data.result.status === "succeeded" && data.result.output?.[0]) {
    try {
      await put(`pixora-generations/${vModelTokenFingerprint(token)}/${id}.json`, JSON.stringify({
        taskId: id,
        output: data.result.output[0],
        completedAt: new Date().toISOString(),
      }), {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      });
    } catch (error) {
      console.error("Could not record Pixora generation", error);
    }
  }

  return Response.json({ status: data.result.status, output: data.result.output, error: data.result.error });
}
