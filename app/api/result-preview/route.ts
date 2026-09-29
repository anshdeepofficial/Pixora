import {
  getAllVModelTokenContexts,
  getVModelTokenByFingerprint,
  unpackVModelTaskId,
} from "../../../lib/vmodel-token";
import {
  imageKitPreviewUrl,
  resolvePackedVModelResult,
} from "../../../lib/result-storage";
import {
  createStoredResultPreview,
  getStoredResultPreview,
} from "../../../lib/result-preview";
import {
  fetchVModelAsset,
  fetchVModelTask,
} from "../../../lib/vmodel-request";

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
          taskId: unpacked.taskId,
          fingerprint: unpacked.fingerprint || candidate.fingerprint,
          token: candidate.token,
          url: data.result.output[0],
        };
      }
    } catch {}
  }

  return null;
}

export async function GET(request: Request) {
  const packedId = new URL(request.url).searchParams.get("id") || "";
  if (!packedId) {
    return Response.json({ error: "Invalid result ID." }, { status: 400 });
  }

  try {
    // Fast path for the current one-hour VModel window.
    const live = await liveResult(packedId);
    if (live) {
      const existing = await getStoredResultPreview(
        live.taskId,
        live.fingerprint,
      ).catch(() => null);
      if (existing) return Response.redirect(existing, 307);

      try {
        const preview = await createStoredResultPreview(
          live.url,
          live.taskId,
          live.fingerprint,
          live.token,
        );
        if (preview) return Response.redirect(preview, 307);
      } catch (error) {
        console.error("Could not create live Pixora preview", error);
      }

      // Last-resort preview for a still-live task: proxy the original inline
      // using the API key so the UI shows an image instead of broken text.
      const upstream = await fetchVModelAsset(
        live.url,
        live.token,
      );
      if (upstream.ok && upstream.body) {
        const contentType = upstream.headers.get("content-type") || "image/png";
        if (contentType.toLowerCase().startsWith("image/")) {
          return new Response(upstream.body, {
            status: 200,
            headers: {
              "Content-Type": contentType,
              ...(upstream.headers.get("content-length")
                ? { "Content-Length": upstream.headers.get("content-length")! }
                : {}),
              "Cache-Control": "private, no-store, max-age=0",
              "X-Pixora-Live-Preview": "true",
            },
          });
        }
      }
    }

    // Durable fallback for older results already copied to ImageKit.
    const result = await resolvePackedVModelResult(
      packedId,
      { allowPreviewFallback: true },
    );
    return Response.redirect(imageKitPreviewUrl(result.url, 1280, 78), 307);
  } catch (error) {
    console.error("Pixora preview route failed", error);
    return Response.json(
      {
        error: error instanceof Error
          ? error.message
          : "Could not prepare browser preview.",
      },
      { status: 502 },
    );
  }
}
