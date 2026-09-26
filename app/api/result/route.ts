import {
  imageKitAttachmentUrl,
  imageKitOriginalUrl,
  resolvePackedVModelResult,
} from "../../../lib/result-storage";

function safeFilename(value: string | null, extension: string) {
  const fallback = `Pixora-${Date.now()}.${extension}`;
  if (!value) return fallback;
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 120);
  const base = cleaned.replace(/\.[a-zA-Z0-9]{2,5}$/i, "") || `Pixora-${Date.now()}`;
  return `${base}.${extension}`;
}

async function resolve(request: Request) {
  const requestUrl = new URL(request.url);
  const packedId = requestUrl.searchParams.get("id") || "";
  try {
    const result = await resolvePackedVModelResult(packedId);
    return { requestUrl, result };
  } catch (error) {
    return {
      error: Response.json(
        { error: error instanceof Error ? error.message : "The original result is unavailable." },
        { status: 502 },
      ),
    };
  }
}

export async function HEAD(request: Request) {
  const resolved = await resolve(request);
  if (resolved.error) return resolved.error;

  const result = resolved.result!;
  const source = imageKitOriginalUrl(result.url);
  try {
    const upstream = await fetch(source, {
      method: "HEAD",
      cache: "no-store",
      redirect: "follow",
    });
    if (!upstream.ok) return new Response(null, { status: 502 });

    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "image/png",
        ...(upstream.headers.get("content-length")
          ? { "Content-Length": upstream.headers.get("content-length")! }
          : {}),
        "Cache-Control": "private, no-store, max-age=0",
        "X-Pixora-Persistent-Result": result.persisted ? "true" : "false",
      },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}

export async function POST(request: Request) {
  const resolved = await resolve(request);
  if (resolved.error) return resolved.error;

  const result = resolved.result!;
  const filename = safeFilename(
    resolved.requestUrl!.searchParams.get("filename"),
    result.extension || "png",
  );

  return Response.json({
    ready: true,
    size: result.size || 0,
    downloadUrl: imageKitAttachmentUrl(result.url, filename),
  }, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function GET(request: Request) {
  const resolved = await resolve(request);
  if (resolved.error) return resolved.error;

  const result = resolved.result!;
  const disposition = resolved.requestUrl!.searchParams.get("disposition") === "inline"
    ? "inline"
    : "attachment";
  const filename = safeFilename(
    resolved.requestUrl!.searchParams.get("filename"),
    result.extension || "png",
  );

  const destination = disposition === "attachment"
    ? imageKitAttachmentUrl(result.url, filename)
    : imageKitOriginalUrl(result.url);

  return Response.redirect(destination, 307);
}
