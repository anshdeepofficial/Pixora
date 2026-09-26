import { randomUUID } from "node:crypto";
import {
  findImageKitAssetByName,
  imageKitConfigured,
  uploadImageKitData,
} from "../../../lib/imagekit";
import {
  imageKitOriginalUrl,
  resolvePackedVModelResult,
} from "../../../lib/result-storage";

export const maxDuration = 300;

const ZIP_JOB_FOLDER = "/pixora-zip-jobs";
const ZIP_JOB_TTL_MS = 60 * 60 * 1000;
const ZIP_PREP_CONCURRENCY = 20;
const MAX_CLASSIC_FILE_SIZE = 0xffffffff;

type ZipSource = {
  url: string;
  filename: string;
};

type ZipJob = {
  createdAt: string;
  filename: string;
  sources: ZipSource[];
};

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run()),
  );
  return results;
}

function extensionFromUrl(value: string) {
  try {
    const match = new URL(value).pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
    const extension = match?.[1]?.toLowerCase();
    if (extension && ["png", "jpg", "jpeg", "webp", "avif"].includes(extension)) {
      return extension === "jpeg" ? "jpg" : extension;
    }
  } catch {}
  return "png";
}

async function prepareSource(rawUrl: string, origin: string, index: number): Promise<ZipSource> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, origin);
  } catch {
    throw new Error(`Image ${index + 1} has an invalid result URL.`);
  }

  if (parsed.pathname === "/api/result") {
    const packedId = parsed.searchParams.get("id") || "";
    const result = await resolvePackedVModelResult(packedId);
    return {
      url: imageKitOriginalUrl(result.url),
      filename: `Pixora-${String(index + 1).padStart(4, "0")}.${result.extension || "png"}`,
    };
  }

  if (parsed.pathname === "/api/download") {
    const nested = parsed.searchParams.get("url");
    if (nested) {
      try {
        parsed = new URL(nested);
      } catch {}
    }
  }

  if (!parsed.hostname.endsWith("imagekit.io")) {
    throw new Error(`Image ${index + 1} is not stored on Pixora's download CDN yet.`);
  }

  return {
    url: imageKitOriginalUrl(parsed.toString()),
    filename: `Pixora-${String(index + 1).padStart(4, "0")}.${extensionFromUrl(parsed.toString())}`,
  };
}

function u16(value: number) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function u32(value: number) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function u64(value: number) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(Math.floor(value)), true);
  return out;
}

function concat(parts: Uint8Array[]) {
  const total = parts.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc: number, bytes: Uint8Array) {
  let next = crc >>> 0;
  for (let index = 0; index < bytes.length; index++) {
    next = CRC_TABLE[(next ^ bytes[index]) & 0xff] ^ (next >>> 8);
  }
  return next >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const dosDate =
    ((year - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { dosTime, dosDate };
}

function localHeader(name: Uint8Array, dosTime: number, dosDate: number) {
  return concat([
    u32(0x04034b50),
    u16(20),
    u16(0x0808),
    u16(0),
    u16(dosTime),
    u16(dosDate),
    u32(0),
    u32(0),
    u32(0),
    u16(name.length),
    u16(0),
    name,
  ]);
}

function dataDescriptor(crc: number, size: number) {
  return concat([
    u32(0x08074b50),
    u32(crc),
    u32(size),
    u32(size),
  ]);
}

function centralHeader(
  name: Uint8Array,
  dosTime: number,
  dosDate: number,
  crc: number,
  size: number,
  localOffset: number,
) {
  const needsZip64Offset = localOffset > 0xffffffff;
  const extra = needsZip64Offset
    ? concat([u16(0x0001), u16(8), u64(localOffset)])
    : new Uint8Array(0);

  return concat([
    u32(0x02014b50),
    u16(needsZip64Offset ? 45 : 20),
    u16(needsZip64Offset ? 45 : 20),
    u16(0x0808),
    u16(0),
    u16(dosTime),
    u16(dosDate),
    u32(crc),
    u32(size),
    u32(size),
    u16(name.length),
    u16(extra.length),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(needsZip64Offset ? 0xffffffff : localOffset),
    name,
    extra,
  ]);
}

function zip64EndOfCentralDirectory(
  entries: number,
  centralSize: number,
  centralOffset: number,
) {
  return concat([
    u32(0x06064b50),
    u64(44),
    u16(45),
    u16(45),
    u32(0),
    u32(0),
    u64(entries),
    u64(entries),
    u64(centralSize),
    u64(centralOffset),
  ]);
}

function zip64Locator(zip64Offset: number) {
  return concat([
    u32(0x07064b50),
    u32(0),
    u64(zip64Offset),
    u32(1),
  ]);
}

function endOfCentralDirectory(
  entries: number,
  centralSize: number,
  centralOffset: number,
  zip64: boolean,
) {
  return concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(zip64 ? 0xffff : entries),
    u16(zip64 ? 0xffff : entries),
    u32(zip64 ? 0xffffffff : centralSize),
    u32(zip64 ? 0xffffffff : centralOffset),
    u16(0),
  ]);
}

async function buildZip(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  sources: ZipSource[],
  signal: AbortSignal,
) {
  let offset = 0;
  const central: Uint8Array[] = [];
  const encoder = new TextEncoder();

  try {
    for (let index = 0; index < sources.length; index++) {
      if (signal.aborted) throw new Error("ZIP download cancelled.");

      const source = sources[index];
      let response: Response;
      try {
        response = await fetch(source.url, {
          cache: "no-store",
          redirect: "follow",
          signal,
        });
      } catch {
        continue;
      }

      if (!response.ok || !response.body) {
        continue;
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (contentType && !contentType.startsWith("image/")) {
        await response.body.cancel().catch(() => undefined);
        continue;
      }

      const name = encoder.encode(source.filename);
      const { dosTime, dosDate } = dosDateTime();
      const localOffset = offset;
      const header = localHeader(name, dosTime, dosDate);
      await writer.write(header);
      offset += header.length;

      const reader = response.body.getReader();
      let crc = 0xffffffff;
      let size = 0;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.length) continue;

        size += value.length;
        if (size > MAX_CLASSIC_FILE_SIZE) {
          await reader.cancel();
          throw new Error(`Image ${index + 1} is larger than 4 GB and cannot be added to this ZIP.`);
        }

        crc = crc32Update(crc, value);
        await writer.write(value);
        offset += value.length;
      }

      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = dataDescriptor(crc, size);
      await writer.write(descriptor);
      offset += descriptor.length;

      central.push(
        centralHeader(name, dosTime, dosDate, crc, size, localOffset),
      );
    }

    const centralOffset = offset;
    for (const record of central) {
      await writer.write(record);
      offset += record.length;
    }

    const centralSize = offset - centralOffset;
    const needsZip64 =
      centralOffset > 0xffffffff ||
      centralSize > 0xffffffff ||
      central.length > 0xffff;

    if (needsZip64) {
      const zip64Offset = offset;
      const zip64End = zip64EndOfCentralDirectory(
        central.length,
        centralSize,
        centralOffset,
      );
      await writer.write(zip64End);
      offset += zip64End.length;

      const locator = zip64Locator(zip64Offset);
      await writer.write(locator);
      offset += locator.length;
    }

    await writer.write(
      endOfCentralDirectory(
        central.length,
        centralSize,
        centralOffset,
        needsZip64,
      ),
    );
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
  }
}

export async function POST(request: Request) {
  if (!imageKitConfigured()) {
    return Response.json(
      { error: "Pixora download storage is not configured." },
      { status: 503 },
    );
  }

  let body: { urls?: string[] };
  try {
    body = await request.json() as { urls?: string[] };
  } catch {
    return Response.json({ error: "Invalid ZIP request." }, { status: 400 });
  }

  const urls = Array.isArray(body.urls)
    ? body.urls.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];

  if (!urls.length) {
    return Response.json({ error: "No images selected." }, { status: 400 });
  }

  try {
    const prepared = await mapLimit(
      urls,
      ZIP_PREP_CONCURRENCY,
      async (url, index) => {
        try {
          return {
            ok: true as const,
            source: await prepareSource(url, request.url, index),
            index,
          };
        } catch (error) {
          return {
            ok: false as const,
            index,
            error: error instanceof Error ? error.message : "Result unavailable.",
          };
        }
      },
    );

    const sources = prepared
      .filter((item): item is { ok: true; source: ZipSource; index: number } => item.ok)
      .map((item) => item.source);
    const skipped = prepared.filter((item) => !item.ok);

    if (!sources.length) {
      return Response.json(
        {
          error: "None of the selected images could be recovered before they expired.",
          skipped: skipped.length,
        },
        { status: 410 },
      );
    }

    const id = randomUUID();
    const job: ZipJob = {
      createdAt: new Date().toISOString(),
      filename: `Pixora-${Date.now()}.zip`,
      sources,
    };

    await uploadImageKitData(
      JSON.stringify(job),
      `${id}.json`,
      ZIP_JOB_FOLDER,
      "application/json",
    );

    return Response.json({
      ready: true,
      count: sources.length,
      skipped: skipped.length,
      skippedIndexes: skipped.map((item) => item.index + 1),
      downloadUrl: `/api/zip?id=${encodeURIComponent(id)}`,
    }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    console.error("Pixora ZIP preparation failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not prepare ZIP." },
      { status: 502 },
    );
  }
}

export async function GET(request: Request) {
  if (!imageKitConfigured()) {
    return Response.json(
      { error: "Pixora download storage is not configured." },
      { status: 503 },
    );
  }

  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^[a-f0-9-]{36}$/i.test(id)) {
    return Response.json({ error: "Invalid ZIP link." }, { status: 400 });
  }

  try {
    const asset = await findImageKitAssetByName(ZIP_JOB_FOLDER, `${id}.json`);
    if (!asset?.url) {
      return Response.json({ error: "ZIP link expired or was not found." }, { status: 404 });
    }

    const jobResponse = await fetch(asset.url, {
      cache: "no-store",
      redirect: "follow",
    });
    if (!jobResponse.ok) {
      return Response.json({ error: "Could not load ZIP job." }, { status: 502 });
    }

    const job = await jobResponse.json() as ZipJob;
    const createdAt = new Date(job.createdAt).getTime();
    if (
      !Number.isFinite(createdAt) ||
      createdAt < Date.now() - ZIP_JOB_TTL_MS ||
      !Array.isArray(job.sources) ||
      !job.sources.length
    ) {
      return Response.json({ error: "ZIP link has expired." }, { status: 410 });
    }

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    void buildZip(writer, job.sources, request.signal);

    const filename = String(job.filename || `Pixora-${Date.now()}.zip`)
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .slice(0, 120);

    return new Response(stream.readable, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Pixora-Zip-Mode": "server-stream",
      },
    });
  } catch (error) {
    console.error("Pixora ZIP download failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not download ZIP." },
      { status: 502 },
    );
  }
}
