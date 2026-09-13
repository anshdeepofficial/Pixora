import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { list, put } from "@vercel/blob";

const TOKEN_PATH = "pixora-private/vmodel-token.enc";

function encryptionKey() {
  const secret = process.env.PIXORA_ADMIN_SECRET;
  if (!secret) throw new Error("PIXORA_ADMIN_SECRET is not configured.");
  return createHash("sha256").update(secret).digest();
}

export async function saveVModelToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const payload = JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") });
  await put(TOKEN_PATH, payload, { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/octet-stream", cacheControlMaxAge: 0 });
}

async function overrideToken() {
  const result = await list({ prefix: TOKEN_PATH, limit: 1 });
  const blob = result.blobs.find((item) => item.pathname === TOKEN_PATH);
  if (!blob) return null;
  const response = await fetch(blob.url, { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load the saved API key.");
  const payload = await response.json() as { iv: string; tag: string; data: string };
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8");
}

export async function getVModelToken() {
  try {
    const saved = await overrideToken();
    if (saved) return saved;
  } catch (error) {
    console.error("Could not read API key override", error);
  }
  return process.env.VMODEL_API_TOKEN || null;
}

export async function getVModelTokenInfo() {
  const saved = await overrideToken();
  const token = saved || process.env.VMODEL_API_TOKEN || "";
  return { configured: Boolean(token), source: saved ? "admin override" : token ? "Vercel environment" : "none", masked: token ? `••••••••${token.slice(-4)}` : "" };
}
