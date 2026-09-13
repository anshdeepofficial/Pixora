import { list } from "@vercel/blob";
import {
  getVModelToken,
  hasVModelTokenOverride,
  vModelTokenFingerprint,
} from "../../../lib/vmodel-token";

const EXISTING_GENERATIONS = 11;

export async function GET() {
  const token = await getVModelToken();
  if (!token) {
    return Response.json(
      { totalGenerated: 0 },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  const isOverride = await hasVModelTokenOverride();
  const startingTotal = isOverride ? 0 : EXISTING_GENERATIONS;
  const prefix = `pixora-generations/${vModelTokenFingerprint(token)}/`;

  try {
    let cursor: string | undefined;
    let recorded = 0;

    do {
      const page = await list({
        prefix,
        limit: 1000,
        cursor,
      });
      recorded += page.blobs.length;
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);

    return Response.json(
      { totalGenerated: startingTotal + recorded },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("Could not load Pixora generation total", error);
    return Response.json(
      { totalGenerated: startingTotal },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
