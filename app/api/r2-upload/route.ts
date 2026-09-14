import { createR2PresignedUrl } from "../../../lib/r2-presign";

type UploadBody = {
  pathname?: string;
  contentType?: string;
  size?: number;
};

const MAX_FILE_BYTES = 12 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function safeFileName(pathname?: string) {
  const rawName = pathname?.split("/").pop() || "image";
  const sanitized = rawName.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(-120);
  return sanitized || "image";
}

export async function POST(request: Request) {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET_NAME?.trim();

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    return Response.json(
      { error: "Cloudflare R2 storage is not configured yet." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const body = await request.json() as UploadBody;
    const contentType = body.contentType?.trim() || "";
    const size = Number(body.size || 0);

    if (!ALLOWED_TYPES.has(contentType)) {
      return Response.json(
        { error: "Use a PNG, JPG, or WEBP image." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) {
      return Response.json(
        { error: "Each image must be 12 MB or smaller." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const key = `pixora-inputs/${Date.now()}-${crypto.randomUUID()}-${safeFileName(body.pathname)}`;
    const credentials = { accountId, accessKeyId, secretAccessKey, bucket, key };
    const [uploadUrl, readUrl] = await Promise.all([
      createR2PresignedUrl({
        ...credentials,
        method: "PUT",
        expiresIn: 15 * 60,
        contentType,
      }),
      createR2PresignedUrl({
        ...credentials,
        method: "GET",
        expiresIn: 6 * 60 * 60,
      }),
    ]);

    return Response.json(
      { uploadUrl, readUrl, key },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not prepare the R2 upload." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}
