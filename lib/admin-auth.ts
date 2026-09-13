import { createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "pixora_admin";

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyAdminPassword(password: string) {
  const expected = process.env.PIXORA_ADMIN_PASSWORD;
  return Boolean(expected && safeEqual(password, expected));
}

export function createAdminSession() {
  const secret = process.env.PIXORA_ADMIN_SECRET;
  if (!secret) throw new Error("PIXORA_ADMIN_SECRET is not configured.");
  const expires = Date.now() + 30 * 60 * 1000;
  const signature = createHmac("sha256", secret).update(String(expires)).digest("base64url");
  return `${expires}.${signature}`;
}

export function verifyAdminSession(value?: string) {
  const secret = process.env.PIXORA_ADMIN_SECRET;
  if (!secret || !value) return false;
  const [expiresValue, signature] = value.split(".");
  const expires = Number(expiresValue);
  if (!Number.isFinite(expires) || expires < Date.now() || !signature) return false;
  const expected = createHmac("sha256", secret).update(expiresValue).digest("base64url");
  return safeEqual(signature, expected);
}
