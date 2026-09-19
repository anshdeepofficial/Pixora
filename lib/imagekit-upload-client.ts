"use client";

type UploadProgress = { percentage: number };

type UploadOptions = {
  access?: string;
  handleUploadUrl?: string;
  onUploadProgress?: (event: UploadProgress) => void;
  signal?: AbortSignal;
};

type AuthResponse = {
  token?: string;
  expire?: number;
  signature?: string;
  publicKey?: string;
  error?: string;
};

type UploadResponse = {
  fileId?: string;
  filePath?: string;
  url?: string;
  name?: string;
  error?: { message?: string };
  message?: string;
};

const cleanupIds = new Set<string>();
let cleanupTimer: number | null = null;

function safeFileName(pathname: string) {
  const name = pathname.split("/").pop() || "image";
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "image";
}

function uploadWithProgress(formData: FormData, onProgress?: (event: UploadProgress) => void, signal?: AbortSignal) {
  return new Promise<UploadResponse>((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;

    const cleanup = () => signal?.removeEventListener("abort", abortUpload);
    const finishResolve = (value: UploadResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abortUpload = () => {
      if (request.readyState !== XMLHttpRequest.DONE) request.abort();
    };

    request.open("POST", "https://upload.imagekit.io/api/v1/files/upload", true);
    request.setRequestHeader("Accept", "application/json");

    if (signal?.aborted) {
      finishReject(new Error("Upload stopped."));
      return;
    }
    signal?.addEventListener("abort", abortUpload, { once: true });
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      onProgress?.({ percentage: Math.min(100, (event.loaded / event.total) * 100) });
    };
    request.onerror = () => finishReject(new Error("Could not upload the image to ImageKit."));
    request.onabort = () => finishReject(new Error("Upload stopped."));
    request.onload = () => {
      let data: UploadResponse = {};
      try { data = JSON.parse(request.responseText || "{}"); } catch {}
      if (request.status >= 200 && request.status < 300 && data.url && data.fileId) finishResolve(data);
      else finishReject(new Error(data.error?.message || data.message || `ImageKit rejected the upload (${request.status || "unknown status"}).`));
    };
    request.send(formData);
  });
}

function scheduleCleanup(fileId: string) {
  cleanupIds.add(fileId);
  if (cleanupTimer !== null) return;
  cleanupTimer = window.setTimeout(() => {
    const fileIds = Array.from(cleanupIds);
    cleanupIds.clear();
    cleanupTimer = null;
    if (!fileIds.length) return;
    void fetch("/api/imagekit-cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileIds, folder: "/pixora-inputs" }),
      keepalive: true,
    }).catch(() => undefined);
  }, 15 * 60 * 1000);
}

export async function upload(pathname: string, file: File, options: UploadOptions = {}) {
  const authResponse = await fetch("/api/imagekit-auth", { cache: "no-store", signal: options.signal });
  const auth = await authResponse.json() as AuthResponse;
  if (!authResponse.ok || !auth.token || !auth.expire || !auth.signature || !auth.publicKey) {
    throw new Error(auth.error || "ImageKit upload authentication is not configured.");
  }

  const formData = new FormData();
  formData.set("file", file);
  formData.set("fileName", safeFileName(pathname));
  formData.set("publicKey", auth.publicKey);
  formData.set("signature", auth.signature);
  formData.set("expire", String(auth.expire));
  formData.set("token", auth.token);
  formData.set("folder", "/pixora-inputs");
  formData.set("useUniqueFileName", "true");
  formData.set("tags", "pixora-input");
  formData.set("checks", "'file.size' <= '12mb' AND 'file.mime' IN ['image/jpeg','image/png','image/webp']");

  options.onUploadProgress?.({ percentage: 0 });
  const uploaded = await uploadWithProgress(formData, options.onUploadProgress, options.signal);
  options.onUploadProgress?.({ percentage: 100 });
  scheduleCleanup(uploaded.fileId!);

  return {
    url: uploaded.url!,
    pathname: uploaded.filePath || pathname,
    contentType: file.type,
    fileId: uploaded.fileId!,
  };
}
