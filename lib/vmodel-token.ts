import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { deleteImageKitFiles, imageKitConfigured, listImageKitAssets, uploadImageKitData } from "./imagekit";

const LEGACY_TOKEN_FILE = "vmodel-token.enc";
const POOL_FILE = "vmodel-pool.enc";
const TOKEN_FOLDER = "/pixora-private";
export const VMODEL_GENERATION_LIMIT = 300;

type TokenSource = "vercel" | "saved";

type TokenEntry = {
  token: string;
  fingerprint: string;
  source: TokenSource;
  addedAt: string;
  baseline: number;
};

type TokenPool = {
  version: 1;
  activeFingerprint: string;
  entries: TokenEntry[];
  activationHistory: string[];
};

export type VModelApiInfo = {
  fingerprint: string;
  masked: string;
  source: TokenSource;
  generated: number;
  status: "Currently using" | "Previously used" | "Used before previous" | "Queued next" | "Queued";
  addedAt: string;
};

function encryptionKey() {
  const secret = process.env.PIXORA_ADMIN_SECRET;
  if (!secret) throw new Error("PIXORA_ADMIN_SECRET is not configured.");
  return createHash("sha256").update(secret).digest();
}

export function vModelTokenFingerprint(token: string) {
  return createHash("sha256").update(token).digest("hex").slice(0, 20);
}

function maskToken(token: string) {
  if (token.length <= 10) return `••••${token.slice(-4)}`;
  return `${token.slice(0, 5)}••••${token.slice(-4)}`;
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

function decryptText(payload: { iv: string; tag: string; data: string }) {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8");
}

async function privateAssets() {
  if (!imageKitConfigured()) return [];
  return listImageKitAssets(`${TOKEN_FOLDER}/`, 100);
}

async function readEncryptedFile(fileName: string) {
  const assets = await privateAssets();
  const asset = assets.find((item) => item.name === fileName || item.filePath === `${TOKEN_FOLDER}/${fileName}`);
  if (!asset?.url) return null;
  const response = await fetch(asset.url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${fileName}.`);
  const payload = await response.json() as { iv: string; tag: string; data: string };
  return decryptText(payload);
}

async function writePool(pool: TokenPool) {
  if (!imageKitConfigured()) throw new Error("ImageKit storage is not configured.");
  await uploadImageKitData(encryptText(JSON.stringify(pool)), POOL_FILE, TOKEN_FOLDER, "application/octet-stream");
}

function normalisePool(pool: TokenPool) {
  const seen = new Set<string>();
  pool.entries = pool.entries.filter((entry) => {
    if (!entry.token || seen.has(entry.fingerprint)) return false;
    seen.add(entry.fingerprint);
    return true;
  });
  pool.activationHistory = pool.activationHistory.filter((fingerprint) => seen.has(fingerprint));
  if (!seen.has(pool.activeFingerprint)) pool.activeFingerprint = pool.entries[0]?.fingerprint || "";
  if (pool.activeFingerprint && !pool.activationHistory.includes(pool.activeFingerprint)) pool.activationHistory.push(pool.activeFingerprint);
  return pool;
}

async function migratePool() {
  const now = new Date().toISOString();
  const envToken = process.env.VMODEL_API_TOKEN?.trim() || "";
  let legacyToken = "";
  try { legacyToken = (await readEncryptedFile(LEGACY_TOKEN_FILE))?.trim() || ""; } catch {}

  const entries: TokenEntry[] = [];
  if (envToken) {
    entries.push({
      token: envToken,
      fingerprint: vModelTokenFingerprint(envToken),
      source: "vercel",
      addedAt: now,
      baseline: 300,
    });
  }
  if (legacyToken && legacyToken !== envToken) {
    entries.push({
      token: legacyToken,
      fingerprint: vModelTokenFingerprint(legacyToken),
      source: "saved",
      addedAt: now,
      baseline: 0,
    });
  }

  const activeToken = legacyToken || envToken;
  const activeFingerprint = activeToken ? vModelTokenFingerprint(activeToken) : "";
  const activationHistory = entries.map((entry) => entry.fingerprint);
  const pool: TokenPool = { version: 1, activeFingerprint, entries, activationHistory };

  if (imageKitConfigured()) {
    await writePool(pool);
    try {
      const assets = await privateAssets();
      const legacyAssets = assets.filter((item) => item.name === LEGACY_TOKEN_FILE || item.filePath === `${TOKEN_FOLDER}/${LEGACY_TOKEN_FILE}`);
      if (legacyAssets.length) await deleteImageKitFiles(legacyAssets.map((item) => item.fileId));
    } catch {}
  }
  return pool;
}

async function loadPool() {
  if (!imageKitConfigured()) {
    const envToken = process.env.VMODEL_API_TOKEN?.trim() || "";
    const entry = envToken ? {
      token: envToken,
      fingerprint: vModelTokenFingerprint(envToken),
      source: "vercel" as const,
      addedAt: new Date().toISOString(),
      baseline: 300,
    } : null;
    return normalisePool({ version: 1, activeFingerprint: entry?.fingerprint || "", entries: entry ? [entry] : [], activationHistory: entry ? [entry.fingerprint] : [] });
  }

  let pool: TokenPool | null = null;
  try {
    const raw = await readEncryptedFile(POOL_FILE);
    if (raw) pool = JSON.parse(raw) as TokenPool;
  } catch (error) {
    console.error("Could not read VModel API pool", error);
  }
  if (!pool?.entries) pool = await migratePool();

  pool = normalisePool(pool);
  const envToken = process.env.VMODEL_API_TOKEN?.trim() || "";
  if (envToken) {
    const fingerprint = vModelTokenFingerprint(envToken);
    if (!pool.entries.some((entry) => entry.fingerprint === fingerprint)) {
      pool.entries.push({ token: envToken, fingerprint, source: "vercel", addedAt: new Date().toISOString(), baseline: 0 });
      await writePool(pool);
    }
  }
  return pool;
}

async function generationCount(entry: TokenEntry) {
  if (!imageKitConfigured()) return entry.baseline;
  try {
    const markers = await listImageKitAssets(`/pixora-counts/${entry.fingerprint}/`, 1000);
    return entry.baseline + markers.length;
  } catch {
    return entry.baseline;
  }
}

function appendActivation(pool: TokenPool, fingerprint: string) {
  pool.activeFingerprint = fingerprint;
  if (pool.activationHistory[pool.activationHistory.length - 1] !== fingerprint) pool.activationHistory.push(fingerprint);
}

async function nextUsableEntry(pool: TokenPool, counts: Map<string, number>, excludeFingerprint: string) {
  const activated = new Set(pool.activationHistory);
  const queued = pool.entries.filter((entry) => !activated.has(entry.fingerprint) && entry.fingerprint !== excludeFingerprint);
  const previous = [...pool.activationHistory].reverse()
    .filter((fingerprint, index, list) => fingerprint !== excludeFingerprint && list.indexOf(fingerprint) === index)
    .map((fingerprint) => pool.entries.find((entry) => entry.fingerprint === fingerprint))
    .filter((entry): entry is TokenEntry => Boolean(entry));
  const candidates = [...queued, ...previous];
  for (const entry of candidates) {
    let count = counts.get(entry.fingerprint);
    if (typeof count !== "number") {
      count = await generationCount(entry);
      counts.set(entry.fingerprint, count);
    }
    if (count < VMODEL_GENERATION_LIMIT) return entry;
  }
  return null;
}

export async function allocateVModelTokenContexts(requested = 1) {
  const amount = Math.max(1, Math.min(50, Math.floor(requested)));
  const pool = await loadPool();
  if (!pool.entries.length || !pool.activeFingerprint) return [];

  const counts = new Map<string, number>();
  for (const entry of pool.entries) counts.set(entry.fingerprint, await generationCount(entry));

  const allocations: Array<{ token: string; fingerprint: string }> = [];
  let changed = false;

  while (allocations.length < amount) {
    let active = pool.entries.find((entry) => entry.fingerprint === pool.activeFingerprint) || pool.entries[0];
    let used = counts.get(active.fingerprint) ?? await generationCount(active);
    const alreadyAllocated = allocations.filter((item) => item.fingerprint === active.fingerprint).length;
    const available = Math.max(0, VMODEL_GENERATION_LIMIT - used - alreadyAllocated);

    if (available <= 0) {
      const next = await nextUsableEntry(pool, counts, active.fingerprint);
      if (!next) break;
      appendActivation(pool, next.fingerprint);
      changed = true;
      continue;
    }

    const take = Math.min(available, amount - allocations.length);
    for (let index = 0; index < take; index++) allocations.push({ token: active.token, fingerprint: active.fingerprint });

    if (allocations.length < amount) {
      const next = await nextUsableEntry(pool, counts, active.fingerprint);
      if (!next) break;
      appendActivation(pool, next.fingerprint);
      changed = true;
    }
  }

  if (changed && imageKitConfigured()) await writePool(pool);
  return allocations;
}

export async function allocateVModelTokenLeases(requested = 1) {
  const contexts = await allocateVModelTokenContexts(requested);
  const expiresAt = Date.now() + 20 * 60 * 1000;

  return contexts.map((context) => {
    const sealed = encryptText(JSON.stringify({
      token: context.token,
      fingerprint: context.fingerprint,
      expiresAt,
    }));
    return Buffer.from(sealed, "utf8").toString("base64url");
  });
}

export function unpackVModelTokenLease(lease: string) {
  if (!lease || lease.length > 4096) throw new Error("Invalid batch allocation.");
  let sealed = "";
  try {
    sealed = Buffer.from(lease, "base64url").toString("utf8");
  } catch {
    throw new Error("Invalid batch allocation.");
  }

  let payload: { token?: string; fingerprint?: string; expiresAt?: number };
  try {
    payload = JSON.parse(decryptText(JSON.parse(sealed))) as { token?: string; fingerprint?: string; expiresAt?: number };
  } catch {
    throw new Error("Invalid batch allocation.");
  }

  if (!payload.token || !payload.fingerprint || !payload.expiresAt || payload.expiresAt < Date.now()) {
    throw new Error("Batch allocation expired. Start the batch again.");
  }
  if (vModelTokenFingerprint(payload.token) !== payload.fingerprint) {
    throw new Error("Invalid batch allocation.");
  }
  return { token: payload.token, fingerprint: payload.fingerprint };
}

export async function getVModelTokenContext() {
  const [context] = await allocateVModelTokenContexts(1);
  return context || null;
}

export async function getVModelToken() {
  return (await getVModelTokenContext())?.token || null;
}

export async function getVModelTokenByFingerprint(fingerprint: string) {
  const pool = await loadPool();
  return pool.entries.find((entry) => entry.fingerprint === fingerprint)?.token || null;
}

export async function getAllVModelTokenContexts() {
  const pool = await loadPool();
  const ordered = [
    ...pool.entries.filter((entry) => entry.fingerprint === pool.activeFingerprint),
    ...pool.entries.filter((entry) => entry.fingerprint !== pool.activeFingerprint),
  ];
  return ordered.map((entry) => ({
    token: entry.token,
    fingerprint: entry.fingerprint,
  }));
}

export async function queueVModelToken(token: string) {
  const pool = await loadPool();
  const fingerprint = vModelTokenFingerprint(token);
  const existing = pool.entries.find((entry) => entry.fingerprint === fingerprint);
  if (existing) return { added: false, fingerprint, info: await getVModelTokenInfo() };

  pool.entries.push({ token, fingerprint, source: "saved", addedAt: new Date().toISOString(), baseline: 0 });
  if (!pool.activeFingerprint) appendActivation(pool, fingerprint);
  await writePool(pool);
  return { added: true, fingerprint, info: await getVModelTokenInfo() };
}

export async function activateVModelToken(fingerprint: string) {
  const pool = await loadPool();
  const entry = pool.entries.find((item) => item.fingerprint === fingerprint);
  if (!entry) throw new Error("API key not found.");
  appendActivation(pool, fingerprint);
  await writePool(pool);
  return getVModelTokenInfo();
}

export async function saveVModelToken(token: string) {
  const result = await queueVModelToken(token);
  await activateVModelToken(result.fingerprint);
}

export async function clearVModelTokenOverride() {
  const envToken = process.env.VMODEL_API_TOKEN?.trim() || "";
  if (!envToken) throw new Error("VMODEL_API_TOKEN is not configured in Vercel.");
  const fingerprint = vModelTokenFingerprint(envToken);
  const pool = await loadPool();
  if (!pool.entries.some((entry) => entry.fingerprint === fingerprint)) {
    pool.entries.push({ token: envToken, fingerprint, source: "vercel", addedAt: new Date().toISOString(), baseline: 0 });
  }
  appendActivation(pool, fingerprint);
  await writePool(pool);
}

export async function maybeRotateVModelTokenAfterGeneration(completedFingerprint: string) {
  if (!imageKitConfigured()) return null;
  const pool = await loadPool();
  if (pool.activeFingerprint !== completedFingerprint) return pool.activeFingerprint;
  const active = pool.entries.find((entry) => entry.fingerprint === completedFingerprint);
  if (!active) return pool.activeFingerprint;

  const count = await generationCount(active);
  if (count < VMODEL_GENERATION_LIMIT) return pool.activeFingerprint;

  const counts = new Map<string, number>([[active.fingerprint, count]]);
  const next = await nextUsableEntry(pool, counts, active.fingerprint);
  if (!next) return pool.activeFingerprint;
  appendActivation(pool, next.fingerprint);
  await writePool(pool);
  return next.fingerprint;
}

export function packVModelTaskId(taskId: string, fingerprint: string) {
  return `${taskId}__k_${fingerprint}`;
}

export function unpackVModelTaskId(value: string) {
  const match = value.match(/^(.*)__k_([a-f0-9]{20})$/);
  return match ? { taskId: match[1], fingerprint: match[2] } : { taskId: value, fingerprint: "" };
}

export async function hasVModelTokenOverride() {
  const pool = await loadPool();
  const active = pool.entries.find((entry) => entry.fingerprint === pool.activeFingerprint);
  return Boolean(active && active.source !== "vercel");
}

export async function getVModelGenerationCount(fingerprint: string) {
  const pool = await loadPool();
  const entry = pool.entries.find((item) => item.fingerprint === fingerprint);
  return entry ? generationCount(entry) : 0;
}

export async function getVModelTokenInfo() {
  const pool = await loadPool();
  const active = pool.entries.find((entry) => entry.fingerprint === pool.activeFingerprint) || null;
  const counts = new Map<string, number>();
  await Promise.all(pool.entries.map(async (entry) => counts.set(entry.fingerprint, await generationCount(entry))));

  const distinctPrevious: string[] = [];
  for (const fingerprint of [...pool.activationHistory].reverse()) {
    if (fingerprint === pool.activeFingerprint || distinctPrevious.includes(fingerprint)) continue;
    distinctPrevious.push(fingerprint);
  }
  const activated = new Set(pool.activationHistory);
  const queued = pool.entries.filter((entry) => !activated.has(entry.fingerprint));

  const ordered = [
    ...(active ? [active] : []),
    ...distinctPrevious.map((fingerprint) => pool.entries.find((entry) => entry.fingerprint === fingerprint)).filter((entry): entry is TokenEntry => Boolean(entry)),
    ...queued,
  ].filter((entry, index, list) => list.findIndex((item) => item.fingerprint === entry.fingerprint) === index);

  const apis: VModelApiInfo[] = ordered.map((entry) => {
    let status: VModelApiInfo["status"] = "Used before previous";
    if (entry.fingerprint === pool.activeFingerprint) status = "Currently using";
    else if (!activated.has(entry.fingerprint)) status = queued[0]?.fingerprint === entry.fingerprint ? "Queued next" : "Queued";
    else if (distinctPrevious[0] === entry.fingerprint) status = "Previously used";
    return {
      fingerprint: entry.fingerprint,
      masked: maskToken(entry.token),
      source: entry.source,
      generated: counts.get(entry.fingerprint) || 0,
      status,
      addedAt: entry.addedAt,
    };
  });

  return {
    configured: Boolean(active?.token),
    source: active?.source === "vercel" ? "Vercel environment" : active ? "saved API rotation" : "none",
    masked: active ? maskToken(active.token) : "",
    activeFingerprint: active?.fingerprint || "",
    generationLimit: VMODEL_GENERATION_LIMIT,
    apis,
  };
}
