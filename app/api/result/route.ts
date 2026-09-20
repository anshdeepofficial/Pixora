import {
  getVModelToken,
  getVModelTokenByFingerprint,
  unpackVModelTaskId,
  vModelTokenFingerprint,
} from "../../../lib/vmodel-token";
import {
  DOWNLOAD_MAX_BYTES,
  getOrCreateCompressedResult,
} from "../../../lib/result-download";

function safeFilename(value: string | null, extension: string) {
  const fallback = `Pixora-${Date.now()}.${extension}`;
  if (!value) return fallback;
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 120);
  if (!cleaned) return fallback;
  return /\.[a-zA-Z0-9]{2,5}$/.test(cleaned) ? cleaned : `${cleaned}.${extension}`;
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

  return {
    token,
    outputUrl,
    requestUrl,
    taskId: unpacked.taskId,
    fingerprint: unpacked.fingerprint || vModelTokenFingerprint(token),
  };
}

export async function HEAD(request: Request) {
  const resolved = await resolveResult(request);
  if (resolved.error) return resolved.error;

  try {
    const compressed = await getOrCreateCompressedResult(
      resolved.outputUrl!.toString(),
      resolved.taskId!,
      resolved.fingerprint!,
      resolved.token!,
    );

    let size = 0;
    if ("buffer" in compressed && compressed.buffer) {
      size = compressed.buffer.length;
    } else if (compressed.url) {
      const stored = await fetch(compressed.url, {
        method: "HEAD",
        cache: "no-store",
        redirect: "follow",
      });
      if (!stored.ok) return new Response(null, { status: 502 });
      size = Number(stored.headers.get("content-length") || 0);
    }

    if (!size || size > DOWNLOAD_MAX_BYTES) {
      return Response.json({ error: "Compressed image size is invalid." }, { status: 502 });
    }

    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(size),
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Pixora-Download-Limit": "15 MiB",
      },
    });
  } catch (error) {
    console.error("Pixora compressed result HEAD failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not prepare compressed download." },
      { status: 502 },
    );
  }
}

export async function GET(request: Request) {
  const resolved = await resolveResult(request);
  if (resolved.error) return resolved.error;

  try {
    const compressed = await getOrCreateCompressedResult(
      resolved.outputUrl!.toString(),
      resolved.taskId!,
      resolved.fingerprint!,
      resolved.token!,
    );

    let body: BodyInit;
    let size = 0;

    if ("buffer" in compressed && compressed.buffer) {
      body = new Uint8Array(compressed.buffer);
      size = compressed.buffer.length;
    } else if (compressed.url) {
      const stored = await fetch(compressed.url, {
        cache: "no-store",
        redirect: "follow",
      });
      if (!stored.ok || !stored.body) {
        return Response.json({ error: "Compressed image could not be loaded." }, { status: 502 });
      }
      size = Number(stored.headers.get("content-length") || 0);
      if (!size || size > DOWNLOAD_MAX_BYTES) {
        return Response.json({ error: "Compressed image exceeded the 15 MB limit." }, { status: 502 });
      }
      body = stored.body;
    } else {
      return Response.json({ error: "Compressed image is unavailable." }, { status: 502 });
    }

    if (!size || size > DOWNLOAD_MAX_BYTES) {
      return Response.json({ error: "Compressed image exceeded the 15 MB limit." }, { status: 502 });
    }

    const disposition = resolved.requestUrl!.searchParams.get("disposition") === "attachment" ? "attachment" : "inline";
    const filename = safeFilename(resolved.requestUrl!.searchParams.get("filename"), "webp");

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(size),
        "Content-Disposition": `${disposition}; filename="${filename}"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Pixora-Download-Limit": "15 MiB",
      },
    });
  } catch (error) {
    console.error("Pixora compressed result download failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not prepare compressed download." },
      { status: 502 },
    );
  }
}
