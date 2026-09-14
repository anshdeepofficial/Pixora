import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { deleteImageKitFiles, imageKitConfigured, listImageKitAssets, uploadImageKitData } from "./imagekit";

const TOKEN_FILE = "vmodel-token.enc";
const TOKEN_FOLDER = "/pixora-private";

function encryptionKey() {
  const secret = process.env.PIXORA_ADMIN_SECRET;
  if (!secret) throw new Error("PIXORA_ADMIN_SECRET is not configured.");
  return createHash("sha256").update(secret).digest();
}

async function tokenAssets() {
  if (!imageKitConfigured()) return [];
  const assets = await listImageKitAssets(`${TOKEN_FOLDER}/`, 100);
  return assets.filter((item) => item.name === TOKEN_FILE || item.filePath === `${TOKEN_FOLDER}/${TOKEN_FILE}`);
}

export async function saveVModelToken(token: string) {
  if (!imageKitConfigured()) throw new Error("ImageKit storage is not configured.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const payload = JSON.stringify({
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  });
  await uploadImageKitData(payload, TOKEN_FILE, TOKEN_FOLDER, "application/octet-stream");
}

export async function clearVModelTokenOverride() {
  if (!imageKitConfigured()) return;
  const assets = await tokenAssets();
  if (assets.length) await deleteImageKitFiles(assets.map((item) => item.fileId));
}

async function overrideToken() {
  const assets = await tokenAssets();
  const asset = assets[0];
  if (!asset?.url) return null;
  const response = await fetch(asset.url, { cache: "no-store" });
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

export function vModelTokenFingerprint(token: string) {
  return createHash("sha256").update(token).digest("hex").slice(0, 20);
}

export async function hasVModelTokenOverride() {
  try {
    return Boolean(await overrideToken());
  } catch {
    return false;
  }
}

export async function getVModelTokenInfo() {
  let saved: string | null = null;
  try { saved = await overrideToken(); } catch {}
  const token = saved || process.env.VMODEL_API_TOKEN || "";
  return {
    configured: Boolean(token),
    source: saved ? "admin override" : token ? "Vercel environment" : "none",
    masked: token ? `••••••••${token.slice(-4)}` : "",
  };
}
