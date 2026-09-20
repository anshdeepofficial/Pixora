export const VMODEL_VERSION = "b7eae3b3e3091ec6ce78162ccf39fea6d1fa9aaf41ec1cac375441d1cdc3997f";

type CreateTaskInput = {
  imageUrl: string;
  referenceImageUrl?: string;
  prompt: string;
  aspectRatio?: string;
};

function promptWithAspectRatioOutpaint(prompt: string, aspectRatio?: string) {
  const requested = aspectRatio?.trim() || "default";
  if (requested === "default") return prompt.trim();

  return `${prompt.trim()}

MANDATORY OUTPUT-FORMAT / OUTPAINTING RULES:
- The final canvas must be exactly ${requested}.
- Achieve the new aspect ratio by extending/outpainting the canvas around the existing image, not by cropping or reframing the original content.
- Preserve the original subject at the same visual scale, camera distance, body size, pose, facial identity, clothing, proportions, orientation, and placement.
- Do not zoom in. Do not zoom out. Do not crop any original subject or important original content.
- Do not stretch, squeeze, rotate, redesign, regenerate, or reposition the subject to make it fit.
- Treat the original image content as the protected composition. Generate new pixels only where extra canvas is needed.
- Extend the existing background, lighting, textures, scenery, floor, walls, sky, environment, and perspective naturally into the newly added canvas area.
- Make the extension seamless, realistic, and consistent with the source image.
- If the source and target aspect ratios differ significantly, keep the entire original composition intact and add the required space around it rather than changing the camera framing.
These output-format rules override any accidental tendency to crop, zoom, reframe, or alter the subject.`;
}

export async function createVModelTask(token: string, input: CreateTaskInput) {
  const response = await fetch("https://api.vmodel.ai/api/tasks/v1/create", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      version: VMODEL_VERSION,
      input: {
        input_image: input.imageUrl,
        ...(input.referenceImageUrl ? { ref_image: input.referenceImageUrl } : {}),
        prompt: promptWithAspectRatioOutpaint(input.prompt, input.aspectRatio),
        aspect_ratio: input.aspectRatio || "default",
        // Highest quality supported by V-Editor: 4 MP generation and 4K result.
        // Keep PNG so Pixora does not introduce lossy JPEG compression.
        megapixels: 4,
        steps: 4,
        result_resolution: 2,
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
