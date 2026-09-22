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
  const base = cleaned.replace(/\.[a-zA-Z0-9]{2,5}$/i, "") || "pixora-image";
  return `${base}.${extension}`;
}

function extensionFrom(contentType: string, sourceUrl: URL) {
  const type = contentType.toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("avif")) return "avif";
  const match = sourceUrl.pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
  return match?.[1]?.toLowerCase() || "png";
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
      method: "HEAD",
      cache: "no-store",
      redirect: "follow",
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8" },
    });
    if (!upstream.ok) return new Response(null, { status: 502 });

    const contentType = upstream.headers.get("content-type") || "image/png";
    const contentLength = upstream.headers.get("content-length");
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        ...(contentLength ? { "Content-Length": contentLength } : {}),
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Pixora-Original-Result": "true",
      },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}

export async function GET(request: Request) {
  const resolved = await resolveAllowedImage(request);
  if (resolved.error) return resolved.error;

  try {
    const upstream = await fetch(resolved.imageUrl!, {
      cache: "no-store",
      redirect: "follow",
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8" },
    });

    if (!upstream.ok || !upstream.body) {
      return Response.json({ error: `Image could not be downloaded (${upstream.status}).` }, { status: 502 });
    }

    const contentType = upstream.headers.get("content-type") || "image/png";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return Response.json({ error: "The upstream URL did not return an image." }, { status: 502 });
    }

    const extension = extensionFrom(contentType, resolved.imageUrl!);
    const filename = safeFilename(resolved.requestUrl!.searchParams.get("filename"), extension);
    const disposition = resolved.requestUrl!.searchParams.get("disposition") === "inline" ? "inline" : "attachment";
    const contentLength = upstream.headers.get("content-length");

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        ...(contentLength ? { "Content-Length": contentLength } : {}),
        "Content-Disposition": `${disposition}; filename="${filename}"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Pixora-Original-Result": "true",
      },
    });
  } catch (error) {
    console.error("Pixora direct download failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Image download request failed." },
      { status: 502 },
    );
  }
}
