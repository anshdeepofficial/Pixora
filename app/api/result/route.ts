import {
  getAllVModelTokenContexts,
  getVModelTokenByFingerprint,
  unpackVModelTaskId,
} from "../../../lib/vmodel-token";
import {
  imageKitAttachmentUrl,
  imageKitOriginalUrl,
  resolvePackedVModelResult,
} from "../../../lib/result-storage";
import {
  fetchVModelAsset,
  fetchVModelTask,
} from "../../../lib/vmodel-request";

function safeFilename(value: string | null, extension: string) {
  const fallback = `Pixora-${Date.now()}.${extension}`;
  if (!value) return fallback;
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 120);
  const base = cleaned.replace(/\.[a-zA-Z0-9]{2,5}$/i, "") || `Pixora-${Date.now()}`;
  return `${base}.${extension}`;
}

function extensionFrom(contentType: string, sourceUrl: string) {
  const type = contentType.toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("avif")) return "avif";
  try {
    const match = new URL(sourceUrl).pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
    return match?.[1]?.toLowerCase() || "png";
  } catch {
    return "png";
  }
}

async function liveResult(packedId: string) {
  const unpacked = unpackVModelTaskId(packedId);
  if (!/^[a-zA-Z0-9_-]{6,120}$/.test(unpacked.taskId)) return null;

  const candidates: Array<{ token: string; fingerprint: string }> = [];
  if (unpacked.fingerprint) {
    const exact = await getVModelTokenByFingerprint(unpacked.fingerprint);
    if (exact) candidates.push({ token: exact, fingerprint: unpacked.fingerprint });
  }

  const all = await getAllVModelTokenContexts();
  for (const item of all) {
    if (!candidates.some((candidate) => candidate.fingerprint === item.fingerprint)) {
      candidates.push(item);
    }
  }

  for (const candidate of candidates) {
    try {
      const { response, data } = await fetchVModelTask(
        unpacked.taskId,
        candidate.token,
      );

      if (response.ok && data.result?.status === "succeeded" && data.result.output?.[0]) {
        return {
          url: data.result.output[0],
          token: candidate.token,
          extension: extensionFrom("", data.result.output[0]),
          persisted: false,
          size: 0,
        };
      }
    } catch {}
  }

  return null;
}

async function resolveResult(request: Request) {
  const requestUrl = new URL(request.url);
  const packedId = requestUrl.searchParams.get("id") || "";
  if (!packedId || !/^[a-zA-Z0-9_-]{6,180}$/.test(packedId)) {
    return { error: Response.json({ error: "Invalid result ID." }, { status: 400 }) };
  }

  // For fresh generations, ask VModel directly first. Do not make ImageKit
  // persistence a prerequisite for downloading an already-finished result.
  const live = await liveResult(packedId);
  if (live) return { requestUrl, result: live };

  // Older items may already have a durable ImageKit copy even after VModel
  // stops exposing the task.
  try {
    const stored = await resolvePackedVModelResult(packedId);
    return { requestUrl, result: { ...stored, token: stored.token || "" } };
  } catch (error) {
    return {
      error: Response.json(
        {
          error: error instanceof Error
            ? error.message
            : "The original generated file is unavailable.",
        },
        { status: 502 },
      ),
    };
  }
}

async function fetchOriginal(url: string, token = "", method: "GET" | "HEAD" = "GET") {
  return fetchVModelAsset(
    url,
    token,
    { method },
  );
}

export async function HEAD(request: Request) {
  const resolved = await resolveResult(request);
  if (resolved.error) return resolved.error;

  const result = resolved.result!;
  try {
    let upstream = await fetchOriginal(result.url, result.token, "HEAD");
    if (!upstream.ok) {
      upstream = await fetchOriginal(result.url, result.token, "GET");
    }
    if (!upstream.ok) return new Response(null, { status: 502 });
    await upstream.body?.cancel().catch(() => undefined);

    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "image/png",
        ...(upstream.headers.get("content-length")
          ? { "Content-Length": upstream.headers.get("content-length")! }
          : {}),
        "Cache-Control": "private, no-store, max-age=0",
        "X-Pixora-Live-Result": result.persisted ? "false" : "true",
      },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
}

export async function POST(request: Request) {
  const resolved = await resolveResult(request);
  if (resolved.error) return resolved.error;

  const result = resolved.result!;
  const filename = safeFilename(
    resolved.requestUrl!.searchParams.get("filename"),
    result.extension || "png",
  );

  if (result.persisted && result.url.includes("imagekit.io")) {
    return Response.json({
      ready: true,
      size: result.size || 0,
      downloadUrl: imageKitAttachmentUrl(result.url, filename),
    }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  }

  // Keep the browser on a same-origin authenticated stream for live VModel
  // originals. This works even if the raw output URL itself needs the API key.
  const direct = new URL(request.url);
  direct.searchParams.set("filename", filename);
  direct.searchParams.set("disposition", "attachment");
  direct.searchParams.set("stream", "1");

  return Response.json({
    ready: true,
    size: result.size || 0,
    downloadUrl: direct.toString(),
  }, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function GET(request: Request) {
  const resolved = await resolveResult(request);
  if (resolved.error) return resolved.error;

  const result = resolved.result!;
  const requestUrl = resolved.requestUrl!;
  const disposition =
    requestUrl.searchParams.get("disposition") === "inline"
      ? "inline"
      : "attachment";

  if (result.persisted && result.url.includes("imagekit.io")) {
    const filename = safeFilename(
      requestUrl.searchParams.get("filename"),
      result.extension || "png",
    );
    const destination = disposition === "attachment"
      ? imageKitAttachmentUrl(result.url, filename)
      : imageKitOriginalUrl(result.url);
    return Response.redirect(destination, 307);
  }

  try {
    const upstream = await fetchOriginal(result.url, result.token, "GET");
    if (!upstream.ok || !upstream.body) {
      return Response.json(
        { error: `VModel original could not be streamed (${upstream.status}).` },
        { status: 502 },
      );
    }

    const contentType = upstream.headers.get("content-type") || "image/png";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return Response.json({ error: "VModel did not return an image file." }, { status: 502 });
    }

    const extension = extensionFrom(contentType, result.url);
    const filename = safeFilename(requestUrl.searchParams.get("filename"), extension);
    const contentLength = upstream.headers.get("content-length");

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        ...(contentLength ? { "Content-Length": contentLength } : {}),
        "Content-Disposition": `${disposition}; filename="${filename}"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Pixora-Live-Result": "true",
      },
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error
          ? error.message
          : "Could not stream the VModel original.",
      },
      { status: 502 },
    );
  }
}
