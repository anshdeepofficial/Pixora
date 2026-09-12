import { list } from "@vercel/blob";

const EXISTING_GENERATIONS = 11;

export async function GET() {
  try {
    let cursor: string | undefined;
    let recorded = 0;

    do {
      const page = await list({
        prefix: "pixora-generations/",
        limit: 1000,
        cursor,
      });
      recorded += page.blobs.length;
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);

    return Response.json(
      { totalGenerated: EXISTING_GENERATIONS + recorded },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("Could not load Pixora generation total", error);
    return Response.json(
      { totalGenerated: EXISTING_GENERATIONS },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
