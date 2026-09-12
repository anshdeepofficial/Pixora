const ALLOWED_HOSTS = ["vmodel.ai", "data.vmodel.ai", "blob.vercel-storage.com"];

export async function GET(request: Request) {
  const value = new URL(request.url).searchParams.get("url");
  if (!value) return Response.json({ error: "Image URL is required." }, { status: 400 });
  let imageUrl: URL;
  try {
    imageUrl = new URL(value);
  } catch {
    return Response.json({ error: "Invalid image URL." }, { status: 400 });
  }
  const allowed = imageUrl.protocol === "https:" && ALLOWED_HOSTS.some((host) => imageUrl.hostname === host || imageUrl.hostname.endsWith(`.${host}`));
  if (!allowed) return Response.json({ error: "This image host is not allowed." }, { status: 403 });

  const upstream = await fetch(imageUrl, { cache: "no-store" });
  if (!upstream.ok || !upstream.body) return Response.json({ error: "Image could not be downloaded." }, { status: 502 });
  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") || "image/png",
      "Content-Disposition": "attachment",
      "Cache-Control": "private, max-age=300",
    },
  });
}
