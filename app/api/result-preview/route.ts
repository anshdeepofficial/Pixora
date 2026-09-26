import {
  imageKitPreviewUrl,
  resolvePackedVModelResult,
} from "../../../lib/result-storage";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const packedId = requestUrl.searchParams.get("id") || "";

  try {
    const result = await resolvePackedVModelResult(packedId, { allowPreviewFallback: true });
    return Response.redirect(imageKitPreviewUrl(result.url, 1280, 78), 307);
  } catch (error) {
    console.error("Pixora preview route failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not prepare browser preview." },
      { status: 502 },
    );
  }
}
