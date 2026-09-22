import {
  getVModelToken,
  getVModelTokenByFingerprint,
  unpackVModelTaskId,
} from "../../../lib/vmodel-token";

function safeFilename(value: string | null, extension: string) {
  const fallback = `Pixora-${Date.now()}.${extension}`;
  if (!value) return fallback;
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 120);
  const base = cleaned.replace(/\.[a-zA-Z0-9]{2,5}$/i, "") || `Pixora-${Date.now()}`;
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

async function resolveResult(request: Request) {
  const requestUrl = new URL(request.url);
  const packedId = requestUrl.searchParams.get("id") || "";
  if (!packedId || !/^[a-zA-Z0-9_-]{6,140}$/.test(packedId)) {
    return { error: Response.json({ error: "Invalid result ID." }, { status: 400 }) };
  }

  const unpacked = unpackVModelTaskId(packedId);
  if (!/^[a-zA-Z0-9_-]{6,100}$/.test(unpacked.taskId)) {
    return { error: Response.json({ error: "Invalid result ID." }, { status: 400 }) };
  }

  const token = unpacked.fingerprint
    ? await getVModelTokenByFingerprint(unpacked.fingerprint)
    : await getVModelToken();
  if (!token) {
    return { error: Response.json({ error: "The VModel API key for this result is unavailable." }, { status: 503 }) };
  }

  const taskResponse = await fetch(
    `https://api.vmodel.ai/api/tasks/v1/get/${encodeURIComponent(unpacked.taskId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    },
  );
  const task = await taskResponse.json().catch(() => ({})) as {
    result?: { status?: string; output?: string[]; error?: string };
  };

  if (!taskResponse.ok || task.result?.status !== "succeeded" || !task.result.output?.[0]) {
    return {
      error: Response.json(
        { error: task.result?.error || "The original result is no longer available." },
        { status: taskResponse.ok ? 410 : 502 },
      ),
    };
  }

  try {
    return {
      requestUrl,
      outputUrl: new URL(task.result.output[0]),
    };
  } catch {
    return { error: Response.json({ error: "Invalid original result URL." }, { status: 502 }) };
  }
}

async function upstreamHead(outputUrl: URL) {
  try {
    const response = await fetch(outputUrl, {
      method: "HEAD",
      cache: "no-store",
      redirect: "follow",
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8" },
    });
    if (!response.ok) return null;
    return response;
  } catch {
    return null;
  }
}

export async function HEAD(request: Request) {
  const resolved = await resolveResult(request);
  if (resolved.error) return resolved.error;

  const upstream = await upstreamHead(resolved.outputUrl!);
  const contentType = upstream?.headers.get("content-type") || "image/png";
  const contentLength = upstream?.headers.get("content-length");

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
}

export async function POST(request: Request) {
  const resolved = await resolveResult(request);
  if (resolved.error) return resolved.error;

  const requestUrl = resolved.requestUrl!;
  requestUrl.searchParams.set("disposition", "attachment");
  return Response.json({
    ready: true,
    size: 0,
    downloadUrl: `${requestUrl.pathname}?${requestUrl.searchParams.toString()}`,
  }, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function GET(request: Request) {
  const resolved = await resolveResult(request);
  if (resolved.error) return resolved.error;

  try {
    const upstream = await fetch(resolved.outputUrl!, {
      cache: "no-store",
      redirect: "follow",
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8" },
    });

    if (!upstream.ok || !upstream.body) {
      return Response.json({ error: `Original image could not be downloaded (${upstream.status}).` }, { status: 502 });
    }

    const contentType = upstream.headers.get("content-type") || "image/png";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return Response.json({ error: "The generated result did not return an image." }, { status: 502 });
    }

    const extension = extensionFrom(contentType, resolved.outputUrl!);
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
    console.error("Pixora original result download failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Image download request failed." },
      { status: 502 },
    );
  }
}
