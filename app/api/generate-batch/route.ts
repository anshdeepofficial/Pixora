import { allocateVModelTokenContexts, packVModelTaskId } from "../../../lib/vmodel-token";
import { createVModelTask } from "../../../lib/vmodel-generate";

type BatchBody = {
  imageUrls?: string[];
  prompt?: string;
  aspectRatio?: string;
  prompts?: string[];
  aspectRatios?: string[];
  resultResolutions?: number[];
};

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

export async function POST(request: Request) {
  const body = await request.json() as BatchBody;
  const imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls : [];
  if (!body.prompt?.trim()) return Response.json({ error: "A prompt is required." }, { status: 400 });
  if (imageUrls.length < 1 || imageUrls.length > 50) {
    return Response.json({ error: "Batch generation supports 1 to 50 images." }, { status: 400 });
  }
  if (imageUrls.some((url) => typeof url !== "string" || !url.startsWith("https://"))) {
    return Response.json({ error: "One or more uploaded image URLs are invalid." }, { status: 400 });
  }

  const allocations = await allocateVModelTokenContexts(imageUrls.length);
  if (!allocations.length) {
    return Response.json({ error: "No usable VModel API key is available. Add another API in Pixora Control." }, { status: 503 });
  }

  // A bounded create window prevents VModel rate-limit bursts when a large batch starts.
  const tasks = await mapLimit(imageUrls, 4, async (imageUrl, index) => {
    const context = allocations[index];
    if (!context) return { index, error: "No queued API key has remaining generation capacity." };
    try {
      const taskPrompt = body.prompts?.[index]?.trim() || body.prompt!;
      const taskAspectRatio = body.aspectRatios?.[index] || body.aspectRatio;
      const requestedResolution = body.resultResolutions?.[index];
      const resultResolution: 0 | 1 | 2 = requestedResolution === 2 ? 2 : requestedResolution === 1 ? 1 : 0;
      const taskId = await createVModelTask(context.token, {
        imageUrl,
        prompt: taskPrompt,
        aspectRatio: taskAspectRatio,
        resultResolution,
      });
      return { index, taskId: packVModelTaskId(taskId, context.fingerprint) };
    } catch (error) {
      return { index, error: error instanceof Error ? error.message : "Could not start generation." };
    }
  });

  if (!tasks.some((task) => "taskId" in task)) {
    return Response.json({ error: "VModel could not start any batch tasks.", tasks }, { status: 502 });
  }
  return Response.json({ tasks });
}
