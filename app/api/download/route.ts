import { DOWNLOAD_MAX_BYTES, compressResultToDownloadLimit } from "../../../lib/result-download";

const ALLOWED_HOSTS = [
  "vmodel.ai",
  "vmimgs.com",
  "replicate.delivery",
  "fal.media",
  "storage.googleapis.com",
  "blob.vercel-storage.com",
  "r2.cloudflarestorage.com",
  "imagekit.io",
];

function isAllowedImageUrl(imageUrl: URL) {
  return imageUrl.protocol === "https:" && ALLOWED_HOSTS.some((host) => imageUrl.hostname === host || imageUrl.hostname.endsWith(`.${host}`));
}

function safeFilename(value: string | null, extension: string) {
  const fallback = `pixora-image.${extension}`;
  if (!value) return fallback;
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 100);
  if (!cleaned) return fallback;
  return /\.[a-zA-Z0-9]{2,5}$/.test(cleaned) ? cleaned : `${cleaned}.${extension}`;
}

async function resolveAllowedImage(request: Request) {
  const requestUrl = new URL(request.url);
  const value = requestUrl.searchParams.get("url");
  if (!value) return { error: Response.json({ error: "Image URL is required." }, { status: 400 }) };

  let imageUrl: URL;
  try {
    imageUrl = new URL(value);
  } catch {
    return { error: Response.json({ error: "Invalid image URL." }, { status: 400 }) };
  }

  if (!isAllowedImageUrl(imageUrl)) {
    return { error: Response.json({ error: `This image host is not allowed: ${imageUrl.hostname}` }, { status: 403 }) };
  }
  return { requestUrl, imageUrl };
}

export async function HEAD(request: Request) {
  const resolved = await resolveAllowedImage(request);
  if (resolved.error) return resolved.error;

  try {
    const upstream = await fetch(resolved.imageUrl!, {
      cache: "no-store",
      redirect: "follow",
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8" },
    });
    if (!upstream.ok) return new Response(null, { status: 502 });

    const contentType = upstream.headers.get("content-type") || "";
    if (contentType && !contentType.toLowerCase().startsWith("image/")) {
      return new Response(null, { status: 502 });
    }

    const source = Buffer.from(await upstream.arrayBuffer());
    const compressed = await compressResultToDownloadLimit(source);
    if (compressed.buffer.length > DOWNLOAD_MAX_BYTES) return new Response(null, { status: 502 });

    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(compressed.buffer.length),
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Pixora-Download-Limit": "15 MB",
      },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}

export async function GET(request: Request) {
  const resolved = await resolveAllowedImage(request);
  if (resolved.error) return resolved.error;
  const requestUrl = resolved.requestUrl!;
  const imageUrl = resolved.imageUrl!;

  try {
    const upstream = await fetch(imageUrl, {
      cache: "no-store",
      redirect: "follow",
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8" },
    });

    if (!upstream.ok) {
      return Response.json({ error: `Image could not be downloaded (${upstream.status}).` }, { status: 502 });
    }

    const contentType = upstream.headers.get("content-type") || "";
    if (contentType && !contentType.toLowerCase().startsWith("image/")) {
      return Response.json({ error: "The upstream URL did not return an image." }, { status: 502 });
    }

    const source = Buffer.from(await upstream.arrayBuffer());
    const compressed = await compressResultToDownloadLimit(source);
    if (compressed.buffer.length > DOWNLOAD_MAX_BYTES) {
      return Response.json({ error: "Compressed image exceeded the 15 MB limit." }, { status: 502 });
    }

    const filename = safeFilename(requestUrl.searchParams.get("filename"), "webp");
    const disposition = requestUrl.searchParams.get("disposition") === "inline" ? "inline" : "attachment";

    return new Response(new Uint8Array(compressed.buffer), {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(compressed.buffer.length),
        "Content-Disposition": `${disposition}; filename="${filename}"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Pixora-Download-Limit": "15 MB",
      },
    });
  } catch (error) {
    console.error("Pixora download compression failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Image download request failed." },
      { status: 502 },
    );
  }
}
