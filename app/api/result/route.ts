import {
  getVModelToken,
  getVModelTokenByFingerprint,
  unpackVModelTaskId,
} from "../../../lib/vmodel-token";

function safeFilename(value: string | null, extension: string) {
  const fallback = `Pixora-${Date.now()}.${extension}`;
  if (!value) return fallback;
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 120);
  if (!cleaned) return fallback;
  return /\.[a-zA-Z0-9]{2,5}$/.test(cleaned) ? cleaned : `${cleaned}.${extension}`;
}

function extensionFromType(type: string, outputUrl: URL) {
  if (type.includes("jpeg")) return "jpg";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  if (type.includes("avif")) return "avif";
  const match = outputUrl.pathname.match(/\.(png|jpe?g|webp|gif|avif)$/i);
  return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "png";
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

  let outputUrl: URL;
  try {
    outputUrl = new URL(task.result.output[0]);
  } catch {
    return { error: Response.json({ error: "Invalid original result URL." }, { status: 502 }) };
  }

  return { token, outputUrl, requestUrl };
}

async function fetchOriginal(
  outputUrl: URL,
  token: string,
  method: "GET" | "HEAD",
) {
  const response = await fetch(outputUrl, {
    method,
    cache: "no-store",
    redirect: "follow",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "image/png,image/jpeg,image/webp,image/*,*/*;q=0.8",
    },
  });
  return response;
}

export async function HEAD(request: Request) {
  const resolved = await resolveResult(request);
  if (resolved.error) return resolved.error;

  const upstream = await fetchOriginal(resolved.outputUrl!, resolved.token!, "HEAD");
  if (!upstream.ok) {
    return Response.json({ error: `Original image is unavailable (${upstream.status}).` }, { status: 502 });
  }

  const headers = new Headers({
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
  });
  const type = upstream.headers.get("content-type");
  const length = upstream.headers.get("content-length");
  if (type) headers.set("Content-Type", type);
  if (length) headers.set("Content-Length", length);
  return new Response(null, { status: 200, headers });
}

export async function GET(request: Request) {
  const resolved = await resolveResult(request);
  if (resolved.error) return resolved.error;

  try {
    const upstream = await fetchOriginal(resolved.outputUrl!, resolved.token!, "GET");
    if (!upstream.ok || !upstream.body) {
      return Response.json(
        { error: `Original image could not be downloaded (${upstream.status}).` },
        { status: 502 },
      );
    }

    const contentType = upstream.headers.get("content-type") || "image/png";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return Response.json({ error: "The original result did not return an image." }, { status: 502 });
    }

    const extension = extensionFromType(contentType, resolved.outputUrl!);
    const disposition = resolved.requestUrl!.searchParams.get("disposition") === "attachment" ? "attachment" : "inline";
    const filename = safeFilename(resolved.requestUrl!.searchParams.get("filename"), extension);

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
    console.error("Pixora original result proxy failed", error);
    return Response.json({ error: "Original image download failed." }, { status: 502 });
  }
}
