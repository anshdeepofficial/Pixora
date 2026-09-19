"use client";

export type ZipProgress = {
  loadedBytes: number;
  totalBytes: number;
  filesDone: number;
  totalFiles: number;
  percent: number;
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

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
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
  return concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0x0808),
    u16(0),
    u16(dosTime),
    u16(dosDate),
    u32(crc),
    u32(size),
    u32(size),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(localOffset),
    name,
  ]);
}

function endOfCentralDirectory(entries: number, centralSize: number, centralOffset: number) {
  return concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries),
    u16(entries),
    u32(centralSize),
    u32(centralOffset),
    u16(0),
  ]);
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export function supportsStreamingZip() {
  return typeof window !== "undefined" && typeof (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker === "function";
}

export async function probeDownloadSizes(urls: string[]) {
  return mapLimit(urls, 6, async (url) => {
    try {
      const response = await fetch(url, { method: "HEAD", cache: "no-store" });
      const size = Number(response.headers.get("content-length") || 0);
      return response.ok && Number.isFinite(size) && size > 0 ? size : 0;
    } catch {
      return 0;
    }
  });
}

export async function streamZipToDisk(
  sources: Array<{ url: string; filename: string }>,
  suggestedName: string,
  onProgress: (progress: ZipProgress) => void,
) {
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (!picker) throw new Error("Streaming ZIP download is not supported by this browser.");

  // Invoke the native picker immediately while the click still has user activation.
  const handle = await picker({
    suggestedName,
    types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }],
  });
  const writable = await handle.createWritable();

  try {
    const sizes = await probeDownloadSizes(sources.map((item) => item.url));
    const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
    let loadedBytes = 0;
    let offset = 0;
    const central: Uint8Array[] = [];
    const encoder = new TextEncoder();

    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      const response = await fetch(source.url, { cache: "no-store" });
      if (!response.ok || !response.body) throw new Error(`Could not download image ${index + 1}.`);

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
        await writable.write(value);
        crc = crc32Update(crc, value);
        size += value.length;
        loadedBytes += value.length;
        offset += value.length;

        const percent = totalBytes > 0 ? Math.min(99, (loadedBytes / totalBytes) * 100) : ((index + 0.5) / sources.length) * 100;
        onProgress({
          loadedBytes,
          totalBytes,
          filesDone: index,
          totalFiles: sources.length,
          percent,
        });
      }

      crc = (crc ^ 0xffffffff) >>> 0;
      if (size > 0xffffffff || localOffset > 0xffffffff) {
        throw new Error("This ZIP exceeds the 4 GB classic ZIP limit. Download the images separately.");
      }

      const descriptor = dataDescriptor(crc, size);
      await writable.write(descriptor);
      offset += descriptor.length;
      central.push(centralHeader(name, dosTime, dosDate, crc, size, localOffset));

      onProgress({
        loadedBytes,
        totalBytes,
        filesDone: index + 1,
        totalFiles: sources.length,
        percent: totalBytes > 0 ? Math.min(99, (loadedBytes / totalBytes) * 100) : ((index + 1) / sources.length) * 100,
      });
    }

    const centralOffset = offset;
    for (const record of central) {
      await writable.write(record);
      offset += record.length;
    }
    const centralSize = offset - centralOffset;
    if (centralOffset > 0xffffffff || centralSize > 0xffffffff) {
      throw new Error("This ZIP exceeds the 4 GB classic ZIP limit. Download the images separately.");
    }

    await writable.write(endOfCentralDirectory(central.length, centralSize, centralOffset));
    await writable.close();
    onProgress({
      loadedBytes,
      totalBytes,
      filesDone: sources.length,
      totalFiles: sources.length,
      percent: 100,
    });
  } catch (error) {
    await writable.abort?.(error).catch(() => undefined);
    throw error;
  }
}
