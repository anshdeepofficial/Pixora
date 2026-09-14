import { getImageKitUploadAuthentication, imageKitConfigured } from "../../../lib/imagekit";

export async function GET() {
  if (!imageKitConfigured()) {
    return Response.json(
      { error: "ImageKit storage is not configured yet." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    return Response.json(getImageKitUploadAuthentication(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not authenticate the ImageKit upload." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
