const ALLOWED_HOSTS = [
  "vmodel.ai",
  "replicate.delivery",
  "fal.media",
  "storage.googleapis.com",
  "blob.vercel-storage.com",
  "r2.cloudflarestorage.com",
];

function isAllowedImageUrl(imageUrl: URL) {
  return imageUrl.protocol === "https:" && ALLOWED_HOSTS.some((host) => imageUrl.hostname === host || imageUrl.hostname.endsWith(`.${host}`));
}

function extensionFromType(type: string, imageUrl: URL) {
  if (type.includes("jpeg")) return "jpg";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  if (type.includes("avif")) return "avif";
  const match = imageUrl.pathname.match(/\.(png|jpe?g|webp|gif|avif)$/i);
  return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "png";
}

function safeFilename(value: string | null, extension: string) {
  const fallback = `pixora-image.${extension}`;
  if (!value) return fallback;
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 100);
  if (!cleaned) return fallback;
  return /\.[a-zA-Z0-9]{2,5}$/.test(cleaned) ? cleaned : `${cleaned}.${extension}`;
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const value = requestUrl.searchParams.get("url");
  if (!value) return Response.json({ error: "Image URL is required." }, { status: 400 });

  let imageUrl: URL;
  try {
    imageUrl = new URL(value);
  } catch {
    return Response.json({ error: "Invalid image URL." }, { status: 400 });
  }

  if (!isAllowedImageUrl(imageUrl)) {
    return Response.json({ error: `This image host is not allowed: ${imageUrl.hostname}` }, { status: 403 });
  }

  try {
    const upstream = await fetch(imageUrl, {
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

    const extension = extensionFromType(contentType, imageUrl);
    const filename = safeFilename(requestUrl.searchParams.get("filename"), extension);
    const disposition = requestUrl.searchParams.get("disposition") === "inline" ? "inline" : "attachment";
    const headers = new Headers({
      "Content-Type": contentType,
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    });
    const length = upstream.headers.get("content-length");
    if (length) headers.set("Content-Length", length);

    return new Response(upstream.body, { status: 200, headers });
  } catch (error) {
    console.error("Pixora download proxy failed", error);
    return Response.json({ error: "Image download request failed." }, { status: 502 });
  }
}
