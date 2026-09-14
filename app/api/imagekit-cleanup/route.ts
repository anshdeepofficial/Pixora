import { deleteImageKitFilesInFolder, imageKitConfigured } from "../../../lib/imagekit";

type CleanupBody = {
  fileIds?: string[];
  folder?: string;
};

const ALLOWED_FOLDERS = new Set(["/pixora-inputs", "/pixora-results"]);

export async function POST(request: Request) {
  if (!imageKitConfigured()) {
    return Response.json({ error: "ImageKit storage is not configured yet." }, { status: 503 });
  }

  try {
    const body = await request.json() as CleanupBody;
    const folder = body.folder?.trim() || "";
    const fileIds = Array.isArray(body.fileIds) ? body.fileIds.slice(0, 100) : [];
    if (!ALLOWED_FOLDERS.has(folder) || !fileIds.length) {
      return Response.json({ error: "Valid ImageKit file IDs and folder are required." }, { status: 400 });
    }

    const deleted = await deleteImageKitFilesInFolder(fileIds, folder);
    return Response.json({ ok: true, deleted }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not clean up ImageKit files." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
