"use client";

export type ZipProgress = {
  loadedBytes: number;
  totalBytes: number;
  filesDone: number;
  totalFiles: number;
  skippedFiles: number;
  percent: number;
  phase: "preparing" | "streaming";
};

type WritableLike = {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
};

type FileHandleLike = {
  createWritable(): Promise<WritableLike>;
};

type SavePicker = (options: {
  suggestedName: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<FileHandleLike>;

type PreparedSource = {
  url: string;
  size?: number;
  skip?: boolean;
};

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

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
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
  return concat([u32(0x08074b50), u32(crc), u32(size), u32(size)]);
}

function centralHeader(
  name: Uint8Array,
  dosTime: number,
  dosDate: number,
  crc: number,
  size: number,
  localOffset: number,
) {
  const zip64Offset = localOffset > 0xffffffff;
  const extra = zip64Offset
    ? concat([u16(0x0001), u16(8), u64(localOffset)])
    : new Uint8Array(0);

  return concat([
    u32(0x02014b50),
    u16(zip64Offset ? 45 : 20),
    u16(zip64Offset ? 45 : 20),
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
    u32(zip64Offset ? 0xffffffff : localOffset),
    name,
    extra,
  ]);
}

function zip64End(entries: number, centralSize: number, centralOffset: number) {
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

export function supportsStreamingZip() {
  return typeof window !== "undefined" &&
    typeof (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker === "function";
}

export async function streamZipToDisk(
  sources: Array<{ url: string; filename: string }>,
  suggestedName: string,
  onProgress: (progress: ZipProgress) => void,
  prepareSource?: (
    source: { url: string; filename: string },
    index: number,
  ) => Promise<PreparedSource>,
) {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (!picker) throw new Error("Streaming ZIP download is not supported by this browser.");

  // Must be the first awaited UI action so Chrome keeps user activation.
  const handle = await picker({
    suggestedName,
    types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }],
  });
  const writable = await handle.createWritable();

  try {
    let preparedCount = 0;
    let skippedFiles = 0;

    const prepared = await mapLimit(sources, 1, async (source, index) => {
      try {
        const next = prepareSource
          ? await prepareSource(source, index)
          : { url: source.url, size: 0 };

        if (next.skip) {
          skippedFiles += 1;
          return null;
        }

        return {
          ...source,
          url: next.url,
          size: typeof next.size === "number" ? next.size : 0,
        };
      } catch {
        skippedFiles += 1;
        return null;
      } finally {
        preparedCount += 1;
        onProgress({
          loadedBytes: 0,
          totalBytes: 0,
          filesDone: preparedCount,
          totalFiles: sources.length,
          skippedFiles,
          percent: Math.min(8, (preparedCount / Math.max(1, sources.length)) * 8),
          phase: "preparing",
        });
      }
    });

    const preparedSources = prepared.filter(
      (item): item is { url: string; filename: string; size: number } => Boolean(item),
    );
    if (!preparedSources.length) {
      throw new Error("None of the selected originals could be prepared for download.");
    }

    const totalBytes = preparedSources.reduce((sum, source) => sum + source.size, 0);
    let loadedBytes = 0;
    let offset = 0;
    const central: Uint8Array[] = [];
    const encoder = new TextEncoder();

    for (let index = 0; index < preparedSources.length; index++) {
      const source = preparedSources[index];

      const fetchImage = async (value: string) => {
        try {
          const candidate = await fetch(value, { cache: "no-store" });
          const type = (candidate.headers.get("content-type") || "").toLowerCase();
          if (candidate.ok && candidate.body && (!type || type.startsWith("image/"))) {
            return candidate;
          }
          await candidate.body?.cancel().catch(() => undefined);
        } catch {}
        return null;
      };

      let response = await fetchImage(source.url);

      // Direct ImageKit/CDN delivery is fastest. If the browser blocks a
      // redirected CDN response, retry only that image through Pixora.
      if (!response) {
        try {
          const fallback = new URL(source.url, window.location.origin);
          if (fallback.pathname === "/api/download" && fallback.searchParams.get("proxy") !== "1") {
            fallback.searchParams.set("proxy", "1");
            response = await fetchImage(`${fallback.pathname}?${fallback.searchParams.toString()}`);
          }
        } catch {}
      }

      if (!response?.body) {
        skippedFiles += 1;
        continue;
      }

      const name = encoder.encode(source.filename);
      const { dosTime, dosDate } = dosDateTime();
      const localOffset = offset;
      const header = localHeader(name, dosTime, dosDate);
      await writable.write(header);
      offset += header.length;

      const reader = response.body.getReader();
      let crc = 0xffffffff;
      let size = 0;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value?.length) continue;

        size += value.length;
        if (size > 0xffffffff) {
          await reader.cancel();
          throw new Error("A single image is larger than the current 4 GB ZIP entry limit.");
        }

        await writable.write(value);
        crc = crc32Update(crc, value);
        loadedBytes += value.length;
        offset += value.length;

        const percent = totalBytes > 0
          ? Math.min(99, 8 + ((loadedBytes / totalBytes) * 91))
          : Math.min(99, 8 + (((index + 0.5) / preparedSources.length) * 91));

        onProgress({
          loadedBytes,
          totalBytes,
          filesDone: index,
          totalFiles: preparedSources.length,
          skippedFiles,
          percent,
          phase: "streaming",
        });
      }

      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = dataDescriptor(crc, size);
      await writable.write(descriptor);
      offset += descriptor.length;

      central.push(
        centralHeader(name, dosTime, dosDate, crc, size, localOffset),
      );

      onProgress({
        loadedBytes,
        totalBytes,
        filesDone: central.length,
        totalFiles: preparedSources.length,
        skippedFiles,
        percent: totalBytes > 0
          ? Math.min(99, 8 + ((loadedBytes / totalBytes) * 91))
          : Math.min(99, 8 + (((index + 1) / preparedSources.length) * 91)),
        phase: "streaming",
      });
    }

    if (!central.length) {
      throw new Error("No downloadable originals remained after validation.");
    }

    const centralOffset = offset;
    for (const record of central) {
      await writable.write(record);
      offset += record.length;
    }
    const centralSize = offset - centralOffset;

    const needsZip64 =
      centralOffset > 0xffffffff ||
      centralSize > 0xffffffff ||
      central.length > 0xffff;

    if (needsZip64) {
      const zip64Offset = offset;
      const end = zip64End(central.length, centralSize, centralOffset);
      await writable.write(end);
      offset += end.length;

      const locator = zip64Locator(zip64Offset);
      await writable.write(locator);
      offset += locator.length;
    }

    await writable.write(
      endOfCentralDirectory(
        central.length,
        centralSize,
        centralOffset,
        needsZip64,
      ),
    );
    await writable.close();

    onProgress({
      loadedBytes,
      totalBytes,
      filesDone: central.length,
      totalFiles: preparedSources.length,
      skippedFiles,
      percent: 100,
      phase: "streaming",
    });

    return {
      saved: central.length,
      skipped: skippedFiles,
    };
  } catch (error) {
    await writable.abort?.(error).catch(() => undefined);
    throw error;
  }
}


type MemoryZipSource = {
  url: string;
  filename: string;
  size?: number;
};

async function fetchZipImage(sourceUrl: string) {
  const fetchImage = async (value: string) => {
    try {
      const candidate = await fetch(value, { cache: "no-store" });
      const type = (candidate.headers.get("content-type") || "").toLowerCase();
      if (candidate.ok && candidate.body && (!type || type.startsWith("image/"))) {
        return candidate;
      }
      await candidate.body?.cancel().catch(() => undefined);
    } catch {}
    return null;
  };

  let response = await fetchImage(sourceUrl);

  if (!response) {
    try {
      const fallback = new URL(sourceUrl, window.location.origin);
      if (
        fallback.pathname === "/api/download" &&
        fallback.searchParams.get("proxy") !== "1"
      ) {
        fallback.searchParams.set("proxy", "1");
        response = await fetchImage(
          `${fallback.pathname}?${fallback.searchParams.toString()}`,
        );
      }
    } catch {}
  }

  return response;
}

export function isMobileBrowser() {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  );
}

export async function buildZipBlob(
  sources: Array<{ url: string; filename: string }>,
  onProgress: (progress: ZipProgress) => void,
  prepareSource?: (
    source: { url: string; filename: string },
    index: number,
  ) => Promise<PreparedSource>,
) {
  let preparedCount = 0;
  let skippedFiles = 0;

  // Keep preparation sequential so VModel recovery stays inside its endpoint
  // throttle. Desktop waits for the complete archive before downloading.
  const prepared = await mapLimit(sources, 1, async (source, index) => {
    try {
      const next = prepareSource
        ? await prepareSource(source, index)
        : { url: source.url, size: 0 };

      if (next.skip) {
        skippedFiles += 1;
        return null;
      }

      return {
        ...source,
        url: next.url,
        size: typeof next.size === "number" ? next.size : 0,
      };
    } catch {
      skippedFiles += 1;
      return null;
    } finally {
      preparedCount += 1;
      onProgress({
        loadedBytes: 0,
        totalBytes: 0,
        filesDone: preparedCount,
        totalFiles: sources.length,
        skippedFiles,
        percent: Math.min(
          12,
          (preparedCount / Math.max(1, sources.length)) * 12,
        ),
        phase: "preparing",
      });
    }
  });

  const preparedSources = prepared.filter(
    (
      item,
    ): item is MemoryZipSource => Boolean(item),
  );

  if (!preparedSources.length) {
    throw new Error("None of the selected originals could be prepared.");
  }

  const totalBytes = preparedSources.reduce(
    (sum, source) => sum + (source.size || 0),
    0,
  );

  const chunks: BlobPart[] = [];
  const central: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let offset = 0;
  let loadedBytes = 0;

  for (let index = 0; index < preparedSources.length; index++) {
    const source = preparedSources[index];
    const response = await fetchZipImage(source.url);

    if (!response?.body) {
      skippedFiles += 1;
      continue;
    }

    const name = encoder.encode(source.filename);
    const { dosTime, dosDate } = dosDateTime();
    const localOffset = offset;
    const header = localHeader(name, dosTime, dosDate);
    chunks.push(header);
    offset += header.length;

    const reader = response.body.getReader();
    let crc = 0xffffffff;
    let size = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;

      size += value.length;
      if (size > 0xffffffff) {
        await reader.cancel();
        throw new Error(
          "A single image is larger than the current 4 GB ZIP entry limit.",
        );
      }

      crc = crc32Update(crc, value);
      chunks.push(value);
      loadedBytes += value.length;
      offset += value.length;

      const percent = totalBytes > 0
        ? Math.min(98, 12 + ((loadedBytes / totalBytes) * 86))
        : Math.min(
            98,
            12 + (((index + 0.5) / preparedSources.length) * 86),
          );

      onProgress({
        loadedBytes,
        totalBytes,
        filesDone: central.length,
        totalFiles: preparedSources.length,
        skippedFiles,
        percent,
        phase: "streaming",
      });
    }

    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = dataDescriptor(crc, size);
    chunks.push(descriptor);
    offset += descriptor.length;

    central.push(
      centralHeader(name, dosTime, dosDate, crc, size, localOffset),
    );

    onProgress({
      loadedBytes,
      totalBytes,
      filesDone: central.length,
      totalFiles: preparedSources.length,
      skippedFiles,
      percent: totalBytes > 0
        ? Math.min(98, 12 + ((loadedBytes / totalBytes) * 86))
        : Math.min(
            98,
            12 + (((index + 1) / preparedSources.length) * 86),
          ),
      phase: "streaming",
    });
  }

  if (!central.length) {
    throw new Error("No downloadable originals remained after validation.");
  }

  const centralOffset = offset;
  for (const record of central) {
    chunks.push(record);
    offset += record.length;
  }
  const centralSize = offset - centralOffset;

  const needsZip64 =
    centralOffset > 0xffffffff ||
    centralSize > 0xffffffff ||
    central.length > 0xffff;

  if (needsZip64) {
    const zip64Offset = offset;
    const end = zip64End(central.length, centralSize, centralOffset);
    chunks.push(end);
    offset += end.length;

    const locator = zip64Locator(zip64Offset);
    chunks.push(locator);
    offset += locator.length;
  }

  chunks.push(
    endOfCentralDirectory(
      central.length,
      centralSize,
      centralOffset,
      needsZip64,
    ),
  );

  const blob = new Blob(chunks, { type: "application/zip" });

  onProgress({
    loadedBytes,
    totalBytes,
    filesDone: central.length,
    totalFiles: preparedSources.length,
    skippedFiles,
    percent: 100,
    phase: "streaming",
  });

  return {
    blob,
    saved: central.length,
    skipped: skippedFiles,
  };
}
