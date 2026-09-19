import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  deleteImageKitFiles,
  findImageKitAssetByName,
  imageKitConfigured,
  listImageKitAssets,
  uploadImageKitData,
  type ImageKitAsset,
} from "./imagekit";

export const PIXORA_SESSION_COOKIE = "pixora_session";
export const HISTORY_TTL_MS = 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

type AccountRecord = {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
};

export type AccountSession = {
  id: string;
  email: string;
  exp: number;
};

export type AccountHistoryItem = {
  url: string;
  prompt: string;
  createdAt: string;
};

const ACCOUNT_FOLDER = "/pixora-accounts/users";
const HISTORY_FOLDER = "/pixora-accounts/history";

function authSecret() {
  const secret = process.env.PIXORA_ADMIN_SECRET?.trim();
  if (!secret) throw new Error("PIXORA_ADMIN_SECRET is not configured.");
  return secret;
}

function encryptionKey() {
  return createHash("sha256").update(`pixora-account-store:${authSecret()}`).digest();
}

function encryptText(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return JSON.stringify({
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  });
}

function decryptText(value: string) {
  const payload = JSON.parse(value) as { iv?: string; tag?: string; data?: string };
  if (!payload.iv || !payload.tag || !payload.data) throw new Error("Invalid encrypted account data.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function normalizeAccountEmail(value: string) {
  return value.trim().toLowerCase();
}

export function validateAccountCredentials(emailValue: string, password: string) {
  const email = normalizeAccountEmail(emailValue);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { email, error: "Enter a valid email address." };
  }
  if (password.length < 6) return { email, error: "Password must be at least 6 characters." };
  if (password.length > 200) return { email, error: "Password is too long." };
  return { email, error: "" };
}

export function accountIdForEmail(emailValue: string) {
  return createHash("sha256").update(normalizeAccountEmail(emailValue)).digest("hex").slice(0, 40);
}

function passwordDigest(password: string, salt: Buffer) {
  return scryptSync(password, salt, 64);
}

function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString("base64")}:${passwordDigest(password, salt).toString("base64")}`;
}

function verifyPassword(password: string, stored: string) {
  const [scheme, saltValue, digestValue] = stored.split(":");
  if (scheme !== "scrypt" || !saltValue || !digestValue) return false;
  try {
    const expected = Buffer.from(digestValue, "base64");
    const actual = passwordDigest(password, Buffer.from(saltValue, "base64"));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

async function readAssetText(asset: ImageKitAsset) {
  if (!asset.url) return null;
  const response = await fetch(asset.url, { cache: "no-store" });
  if (!response.ok) throw new Error("Could not read account storage.");
  return response.text();
}

async function readAccountById(id: string) {
  const asset = await findImageKitAssetByName(ACCOUNT_FOLDER, `${id}.enc`);
  if (!asset) return null;
  const raw = await readAssetText(asset);
  if (!raw) return null;
  return JSON.parse(decryptText(raw)) as AccountRecord;
}

export async function findAccountByEmail(email: string) {
  return readAccountById(accountIdForEmail(email));
}

export async function createAccount(emailValue: string, password: string) {
  if (!imageKitConfigured()) throw new Error("Account storage is not configured.");
  const email = normalizeAccountEmail(emailValue);
  const id = accountIdForEmail(email);
  const existing = await readAccountById(id);
  if (existing) return { account: existing, created: false };

  const account: AccountRecord = {
    id,
    email,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  await uploadImageKitData(
    encryptText(JSON.stringify(account)),
    `${id}.enc`,
    ACCOUNT_FOLDER,
    "application/octet-stream",
  );
  return { account, created: true };
}

export function accountPasswordMatches(account: AccountRecord, password: string) {
  return verifyPassword(password, account.passwordHash);
}

function sessionSignature(payload: string) {
  return createHmac("sha256", authSecret()).update(`pixora-session:${payload}`).digest("base64url");
}

export function createSessionToken(account: Pick<AccountRecord, "id" | "email">) {
  const session: AccountSession = {
    id: account.id,
    email: account.email,
    exp: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${payload}.${sessionSignature(payload)}`;
}

export function readSessionToken(value?: string | null): AccountSession | null {
  if (!value) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = sessionSignature(payload);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length || !timingSafeEqual(expectedBuffer, signatureBuffer)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AccountSession;
    if (!session.id || !session.email || !session.exp || session.exp <= Date.now()) return null;
    if (session.id !== accountIdForEmail(session.email)) return null;
    return session;
  } catch {
    return null;
  }
}

function historyFolder(accountId: string) {
  if (!/^[a-f0-9]{40}$/.test(accountId)) throw new Error("Invalid account.");
  return `${HISTORY_FOLDER}/${accountId}`;
}

function isFreshHistoryItem(item: AccountHistoryItem, now = Date.now()) {
  const created = new Date(item.createdAt).getTime();
  return Number.isFinite(created) && created <= now + 5 * 60 * 1000 && created > now - HISTORY_TTL_MS;
}

async function decodeHistoryAsset(asset: ImageKitAsset) {
  try {
    const raw = await readAssetText(asset);
    if (!raw) return null;
    const item = JSON.parse(decryptText(raw)) as AccountHistoryItem;
    return { asset, item };
  } catch {
    return null;
  }
}

export async function getAccountHistory(accountId: string) {
  if (!imageKitConfigured()) return [];
  const assets = await listImageKitAssets(`${historyFolder(accountId)}/`, 1000);
  const decoded = await Promise.all(assets.map(decodeHistoryAsset));
  const now = Date.now();
  const expiredIds: string[] = [];
  const items: AccountHistoryItem[] = [];

  for (const entry of decoded) {
    if (!entry?.asset.fileId) continue;
    if (!entry.item || !isFreshHistoryItem(entry.item, now)) {
      expiredIds.push(entry.asset.fileId);
      continue;
    }
    items.push(entry.item);
  }

  if (expiredIds.length) {
    await deleteImageKitFiles(expiredIds).catch(() => undefined);
  }

  return Array.from(new Map(items.map((item) => [item.url, item])).values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function saveAccountHistoryItem(accountId: string, input: AccountHistoryItem) {
  if (!imageKitConfigured()) throw new Error("Account storage is not configured.");
  if (!input.url?.startsWith("https://")) throw new Error("Invalid generated image URL.");
  const item: AccountHistoryItem = {
    url: input.url.slice(0, 3000),
    prompt: String(input.prompt || "").slice(0, 1000),
    createdAt: new Date(input.createdAt || Date.now()).toISOString(),
  };
  if (!isFreshHistoryItem(item)) throw new Error("This history item is already expired.");

  const createdMs = new Date(item.createdAt).getTime();
  const urlHash = createHash("sha256").update(item.url).digest("hex").slice(0, 20);
  await uploadImageKitData(
    encryptText(JSON.stringify(item)),
    `${createdMs}-${urlHash}.enc`,
    historyFolder(accountId),
    "application/octet-stream",
  );
  return item;
}

export async function deleteAccountHistoryItem(accountId: string, url: string) {
  const assets = await listImageKitAssets(`${historyFolder(accountId)}/`, 1000);
  const decoded = await Promise.all(assets.map(decodeHistoryAsset));
  const fileIds = decoded
    .filter((entry) => entry?.item?.url === url && entry.asset.fileId)
    .map((entry) => entry!.asset.fileId);
  if (fileIds.length) await deleteImageKitFiles(fileIds);
  return fileIds.length;
}

export async function clearAccountHistory(accountId: string) {
  const assets = await listImageKitAssets(`${historyFolder(accountId)}/`, 1000);
  const fileIds = assets.map((asset) => asset.fileId).filter(Boolean);
  if (fileIds.length) await deleteImageKitFiles(fileIds);
  return fileIds.length;
}
