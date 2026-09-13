import { list } from "@vercel/blob";

type RecoveredItem = {
  url: string;
  prompt: string;
  createdAt: string;
};

const HISTORY_VERSION = "2026-09-13T08:27:07.000Z";

async function listAll(prefix: string) {
  const blobs: Awaited<ReturnType<typeof list>>["blobs"] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, limit: 1000, cursor });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

export async function GET() {
  try {
    const [metadataBlobs, resultBlobs] = await Promise.all([
      listAll("pixora-generations/"),
      listAll("pixora-results/"),
    ]);
    const recovered: RecoveredItem[] = [];

    for (let start = 0; start < metadataBlobs.length; start += 10) {
      const batch = metadataBlobs.slice(start, start + 10);
      const items = await Promise.all(batch.map(async (blob) => {
        try {
          const response = await fetch(blob.url, { cache: "no-store" });
          if (!response.ok) return null;
          const data = await response.json() as { output?: string; completedAt?: string };
          if (!data.output?.startsWith("https://")) return null;
          return {
            url: data.output,
            prompt: "Recovered Pixora generation",
            createdAt: data.completedAt || new Date(blob.uploadedAt).toISOString(),
          } satisfies RecoveredItem;
        } catch {
          return null;
        }
      }));
      recovered.push(...items.filter((item): item is RecoveredItem => item !== null));
    }

    const knownUrls = new Set(recovered.map((item) => item.url));
    for (const blob of resultBlobs) {
      if (!knownUrls.has(blob.url)) {
        recovered.push({
          url: blob.url,
          prompt: "Recovered Pixora generation",
          createdAt: new Date(blob.uploadedAt).toISOString(),
        });
      }
    }

    const clearedAt = new Date(HISTORY_VERSION).getTime();
    const unique = Array.from(new Map(recovered.map((item) => [item.url, item])).values())
      .filter((item) => new Date(item.createdAt).getTime() >= clearedAt)
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

    return Response.json(
      { history: unique, historyVersion: HISTORY_VERSION },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("Could not recover shared Pixora history", error);
    return Response.json({ error: "Could not recover shared history." }, { status: 500 });
  }
}
