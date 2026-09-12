/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  UPLOADS: R2Bucket;
  VMODEL_API_TOKEN?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

    if (url.pathname === "/api/upload" && request.method === "POST") {
      const type = request.headers.get("content-type") || "";
      if (!type.startsWith("image/")) return json({ error: "Please upload a valid image." }, 400);
      const size = Number(request.headers.get("content-length") || 0);
      if (size > 12 * 1024 * 1024) return json({ error: "Image must be under 12 MB." }, 413);
      const extension = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
      const key = `inputs/${crypto.randomUUID()}.${extension}`;
      await env.UPLOADS.put(key, request.body, { httpMetadata: { contentType: type } });
      return json({ url: `${url.origin}/api/files/${key}` });
    }

    if (url.pathname.startsWith("/api/files/") && request.method === "GET") {
      const key = url.pathname.slice("/api/files/".length);
      if (!key.startsWith("inputs/")) return new Response("Not found", { status: 404 });
      const object = await env.UPLOADS.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Cache-Control", "public, max-age=3600");
      return new Response(object.body, { headers });
    }

    if (url.pathname === "/api/download" && request.method === "GET") {
      const value = url.searchParams.get("url");
      if (!value) return json({ error: "Image URL is required." }, 400);

      let imageUrl: URL;
      try {
        imageUrl = new URL(value);
      } catch {
        return json({ error: "Invalid image URL." }, 400);
      }

      const allowedHosts = ["vmodel.ai", "data.vmodel.ai", "blob.vercel-storage.com"];
      const allowed = imageUrl.protocol === "https:" && allowedHosts.some(
        (host) => imageUrl.hostname === host || imageUrl.hostname.endsWith(`.${host}`)
      );
      if (!allowed) return json({ error: "This image host is not allowed." }, 403);

      try {
        const upstream = await fetch(imageUrl.toString(), {
          redirect: "follow",
          headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8" },
        });
        if (!upstream.ok || !upstream.body) {
          return json({ error: `Image could not be downloaded (${upstream.status}).` }, 502);
        }

        const upstreamType = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const pathExtension = imageUrl.pathname.match(/\.(png|jpe?g|webp|gif|avif)(?:$|\/)/i)?.[1]?.toLowerCase();
        const extension = upstreamType.includes("jpeg") ? "jpg"
          : upstreamType.includes("webp") ? "webp"
          : upstreamType.includes("gif") ? "gif"
          : upstreamType.includes("avif") ? "avif"
          : pathExtension?.replace("jpeg", "jpg") || "png";
        const contentType = upstreamType.startsWith("image/") ? upstreamType : `image/${extension === "jpg" ? "jpeg" : extension}`;
        const requestedName = (url.searchParams.get("filename") || "pixora-image")
          .replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 100);
        const filename = /\.[a-zA-Z0-9]{2,5}$/.test(requestedName) ? requestedName : `${requestedName}.${extension}`;
        const disposition = url.searchParams.get("disposition") === "inline" ? "inline" : "attachment";

        return new Response(upstream.body, {
          headers: {
            "Content-Type": contentType,
            "Content-Disposition": `${disposition}; filename="${filename}"`,
            "Cache-Control": "private, no-store, max-age=0",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch (error) {
        console.error("Pixora download proxy failed", error);
        return json({ error: "Image download request failed." }, 502);
      }
    }

    if (url.pathname === "/api/stats" && request.method === "GET") {
      const listed = await env.UPLOADS.list({ prefix: "generations/" });
      return json({ totalGenerated: 11 + listed.objects.length });
    }

    if (url.pathname === "/api/generate" && request.method === "POST") {
      if (!env.VMODEL_API_TOKEN) return json({ error: "Add your VMODEL_API_TOKEN to connect V-Editor." }, 503);
      const body = await request.json() as { imageUrl?: string; prompt?: string; aspectRatio?: string };
      if (!body.imageUrl?.startsWith(url.origin) || !body.prompt?.trim()) return json({ error: "Image and prompt are required." }, 400);
      const response = await fetch("https://api.vmodel.ai/api/tasks/v1/create", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.VMODEL_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "b7eae3b3e3091ec6ce78162ccf39fea6d1fa9aaf41ec1cac375441d1cdc3997f",
          input: { input_image: body.imageUrl, prompt: body.prompt.trim(), aspect_ratio: body.aspectRatio || "default", megapixels: 1, steps: 4, result_resolution: 0, file_format: "png", disable_safety_checker: false },
        }),
      });
      const data = await response.json() as { result?: { task_id?: string }; message?: { en?: string } };
      if (!response.ok || !data.result?.task_id) return json({ error: data.message?.en || "VModel rejected the request." }, response.ok ? 502 : response.status);
      return json({ taskId: data.result.task_id });
    }

    if (url.pathname === "/api/task" && request.method === "GET") {
      if (!env.VMODEL_API_TOKEN) return json({ error: "VModel API is not configured." }, 503);
      const taskId = url.searchParams.get("id");
      if (!taskId || !/^[a-zA-Z0-9_-]{6,80}$/.test(taskId)) return json({ error: "Invalid task ID." }, 400);
      const response = await fetch(`https://api.vmodel.ai/api/tasks/v1/get/${encodeURIComponent(taskId)}`, { headers: { "Authorization": `Bearer ${env.VMODEL_API_TOKEN}` } });
      const data = await response.json() as { result?: { status?: string; output?: string[]; error?: string } };
      if (!response.ok || !data.result) return json({ error: "Could not check generation." }, 502);
      if (data.result.status === "succeeded" && data.result.output?.[0]) {
        await env.UPLOADS.put(`generations/${taskId}.json`, JSON.stringify({
          taskId,
          output: data.result.output[0],
          completedAt: new Date().toISOString(),
        }), { httpMetadata: { contentType: "application/json" } });
      }
      return json({ status: data.result.status, output: data.result.output, error: data.result.error });
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
