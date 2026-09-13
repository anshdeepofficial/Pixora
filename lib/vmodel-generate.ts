export const VMODEL_VERSION = "b7eae3b3e3091ec6ce78162ccf39fea6d1fa9aaf41ec1cac375441d1cdc3997f";

type CreateTaskInput = {
  imageUrl: string;
  referenceImageUrl?: string;
  prompt: string;
  aspectRatio?: string;
};

export async function createVModelTask(token: string, input: CreateTaskInput) {
  const response = await fetch("https://api.vmodel.ai/api/tasks/v1/create", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      version: VMODEL_VERSION,
      input: {
        input_image: input.imageUrl,
        ...(input.referenceImageUrl ? { ref_image: input.referenceImageUrl } : {}),
        prompt: input.prompt.trim(),
        aspect_ratio: input.aspectRatio || "default",
        megapixels: 1,
        steps: 4,
        result_resolution: 0,
        file_format: "png",
        disable_safety_checker: false,
      },
    }),
  });

  const data = await response.json() as { result?: { task_id?: string }; message?: { en?: string } };
  if (!response.ok || !data.result?.task_id) {
    throw new Error(data.message?.en || "VModel rejected the request.");
  }
  return data.result.task_id;
}
