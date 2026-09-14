const encoder = new TextEncoder();

function rfc3986(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeKey(key: string) {
  return key.split("/").map(rfc3986).join("/");
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return hex(new Uint8Array(digest));
}

async function hmac(key: Uint8Array, value: string) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
  return new Uint8Array(signature);
}

function canonicalQuery(entries: Array<[string, string]>) {
  return entries
    .map(([key, value]) => [rfc3986(key), rfc3986(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey < rightKey) return -1;
      if (leftKey > rightKey) return 1;
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
      return 0;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

type PresignOptions = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  key: string;
  method: "GET" | "PUT";
  expiresIn: number;
  contentType?: string;
};

export async function createR2PresignedUrl(options: PresignOptions) {
  const {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    key,
    method,
    expiresIn,
    contentType,
  } = options;

  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 604800) {
    throw new Error("R2 presigned URL expiry must be between 1 second and 7 days.");
  }

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const host = `${bucket}.${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${encodeKey(key)}`;
  const signedHeaders = contentType ? "content-type;host" : "host";
  const canonicalHeaders = contentType
    ? `content-type:${contentType.trim()}\nhost:${host}\n`
    : `host:${host}\n`;

  const query = canonicalQuery([
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD"],
    ["X-Amz-Credential", `${accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresIn)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ]);

  const canonicalRequest = `${method}\n${canonicalUri}\n${query}\n${canonicalHeaders}${signedHeaders}\nUNSIGNED-PAYLOAD`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256(canonicalRequest)}`;

  const dateKey = await hmac(encoder.encode(`AWS4${secretAccessKey}`), dateStamp);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, service);
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));

  return `https://${host}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
}
