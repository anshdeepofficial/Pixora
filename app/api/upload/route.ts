import { put } from "@vercel/blob";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const type = request.headers.get("content-type") || "";
  if (!type.startsWith("image/")) return Response.json({ error: "Please upload a valid image." }, { status: 400 });
  const size = Number(request.headers.get("content-length") || 0);
  if (size > 12 * 1024 * 1024) return Response.json({ error: "Image must be under 12 MB." }, { status: 413 });
  if (!request.body) return Response.json({ error: "The uploaded image is empty." }, { status: 400 });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return Response.json({ error: "Vercel Blob storage is not connected yet." }, { status: 503 });

  const rawName = decodeURIComponent(request.headers.get("x-file-name") || "image").replace(/[^a-zA-Z0-9._-]/g, "-");
  const blob = await put(`pixora-inputs/${Date.now()}-${rawName}`, request.body, {
    access: "public",
    addRandomSuffix: true,
    contentType: type,
  });
  return Response.json({ url: blob.url });
}
