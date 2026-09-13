import { getVModelToken } from "../../../lib/vmodel-token";
import { createVModelTask } from "../../../lib/vmodel-generate";

type GenerateBody = {
  imageUrl?: string;
  referenceImageUrl?: string;
  prompt?: string;
  aspectRatio?: string;
};

function validHttpsUrl(value?: string) {
  return Boolean(value?.startsWith("https://"));
}

export async function POST(request: Request) {
  const token = await getVModelToken();
  if (!token) return Response.json({ error: "VModel API is not configured." }, { status: 503 });

  const body = await request.json() as GenerateBody;
  if (!validHttpsUrl(body.imageUrl) || !body.prompt?.trim()) {
    return Response.json({ error: "Image and prompt are required." }, { status: 400 });
  }
  if (body.referenceImageUrl && !validHttpsUrl(body.referenceImageUrl)) {
    return Response.json({ error: "Reference image URL is invalid." }, { status: 400 });
  }

  try {
    const taskId = await createVModelTask(token, {
      imageUrl: body.imageUrl!,
      referenceImageUrl: body.referenceImageUrl,
      prompt: body.prompt,
      aspectRatio: body.aspectRatio,
    });
    return Response.json({ taskId });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not start generation." }, { status: 502 });
  }
}
