import { getVModelToken } from "../../../lib/vmodel-token";
import { createVModelTask } from "../../../lib/vmodel-generate";

type BatchBody = {
  imageUrls?: string[];
  prompt?: string;
  aspectRatio?: string;
};

export async function POST(request: Request) {
  const token = await getVModelToken();
  if (!token) return Response.json({ error: "VModel API is not configured." }, { status: 503 });

  const body = await request.json() as BatchBody;
  const imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls : [];
  if (!body.prompt?.trim()) return Response.json({ error: "A prompt is required." }, { status: 400 });
  if (imageUrls.length < 1 || imageUrls.length > 50) {
    return Response.json({ error: "Batch generation supports 1 to 50 images." }, { status: 400 });
  }
  if (imageUrls.some((url) => typeof url !== "string" || !url.startsWith("https://"))) {
    return Response.json({ error: "One or more uploaded image URLs are invalid." }, { status: 400 });
  }

  const tasks = await Promise.all(imageUrls.map(async (imageUrl, index) => {
    try {
      const taskId = await createVModelTask(token, {
        imageUrl,
        prompt: body.prompt!,
        aspectRatio: body.aspectRatio,
      });
      return { index, taskId };
    } catch (error) {
      return { index, error: error instanceof Error ? error.message : "Could not start generation." };
    }
  }));

  if (!tasks.some((task) => "taskId" in task)) {
    return Response.json({ error: "VModel could not start any batch tasks.", tasks }, { status: 502 });
  }
  return Response.json({ tasks });
}
