import { createVModelTask } from "../../../lib/vmodel-generate";
import { packVModelTaskId, unpackVModelTokenLease } from "../../../lib/vmodel-token";

type ItemBody = {
  imageUrl?: string;
  prompt?: string;
  aspectRatio?: string;
  lease?: string;
};

export async function POST(request: Request) {
  const body = await request.json() as ItemBody;
  if (!body.imageUrl?.startsWith("https://") || !body.prompt?.trim() || !body.lease) {
    return Response.json({ error: "Image, prompt, and batch allocation are required." }, { status: 400 });
  }

  try {
    const context = unpackVModelTokenLease(body.lease);
    const taskId = await createVModelTask(context.token, {
      imageUrl: body.imageUrl,
      prompt: body.prompt,
      aspectRatio: body.aspectRatio,
    });
    return Response.json({
      taskId: packVModelTaskId(taskId, context.fingerprint),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Could not start generation.",
    }, { status: 502 });
  }
}
