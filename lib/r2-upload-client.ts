"use client";

type UploadProgress = { percentage: number };

type UploadOptions = {
  access?: string;
  handleUploadUrl?: string;
  onUploadProgress?: (event: UploadProgress) => void;
};

type PreparedUpload = {
  uploadUrl?: string;
  readUrl?: string;
  key?: string;
  error?: string;
};

function putWithProgress(
  uploadUrl: string,
  file: Blob,
  contentType: string,
  onProgress?: (event: UploadProgress) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", uploadUrl, true);
    request.setRequestHeader("Content-Type", contentType);
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      onProgress?.({ percentage: Math.min(100, (event.loaded / event.total) * 100) });
    };
    request.onerror = () => reject(new Error("Could not upload the image to Cloudflare R2."));
    request.onabort = () => reject(new Error("The Cloudflare R2 upload was cancelled."));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`Cloudflare R2 rejected the upload (${request.status || "unknown status"}).`));
    };
    request.send(file);
  });
}

export async function upload(pathname: string, file: File, options: UploadOptions = {}) {
  const prepareResponse = await fetch("/api/r2-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pathname,
      contentType: file.type,
      size: file.size,
    }),
  });

  const prepared = await prepareResponse.json() as PreparedUpload;
  if (!prepareResponse.ok || !prepared.uploadUrl || !prepared.readUrl) {
    throw new Error(prepared.error || "Could not prepare the Cloudflare R2 upload.");
  }

  options.onUploadProgress?.({ percentage: 0 });
  await putWithProgress(prepared.uploadUrl, file, file.type, options.onUploadProgress);
  options.onUploadProgress?.({ percentage: 100 });

  return {
    url: prepared.readUrl,
    pathname: prepared.key || pathname,
    contentType: file.type,
  };
}
