const VERSION = "b7eae3b3e3091ec6ce78162ccf39fea6d1fa9aaf41ec1cac375441d1cdc3997f";

export async function POST(request: Request) {
  const token = process.env.VMODEL_API_TOKEN;
  if (!token) return Response.json({ error: "VModel API is not configured." }, { status: 503 });
  const body = await request.json() as { imageUrl?: string; prompt?: string; aspectRatio?: string };
  if (!body.imageUrl?.startsWith("https://") || !body.prompt?.trim()) return Response.json({ error: "Image and prompt are required." }, { status: 400 });

  const response = await fetch("https://api.vmodel.ai/api/tasks/v1/create", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      version: VERSION,
      input: {
        input_image: body.imageUrl,
        prompt: body.prompt.trim(),
        aspect_ratio: body.aspectRatio || "default",
        megapixels: 1,
        steps: 4,
        result_resolution: 0,
        file_format: "png",
        disable_safety_checker: false,
      },
    }),
  });
  const data = await response.json() as { result?: { task_id?: string }; message?: { en?: string } };
  if (!response.ok || !data.result?.task_id) return Response.json({ error: data.message?.en || "VModel rejected the request." }, { status: response.ok ? 502 : response.status });
  return Response.json({ taskId: data.result.task_id });
}
