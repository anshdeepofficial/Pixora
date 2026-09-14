import { deleteExpiredImageKitFiles, imageKitConfigured } from "../../../lib/imagekit";

const EXISTING_GENERATIONS = 11;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

export async function GET() {
  if (!imageKitConfigured()) {
    return Response.json(
      { totalGenerated: EXISTING_GENERATIONS },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  try {
    const [inputs, results] = await Promise.all([
      deleteExpiredImageKitFiles("/pixora-inputs/", ONE_HOUR),
      deleteExpiredImageKitFiles("/pixora-results/", ONE_DAY),
    ]);

    return Response.json(
      {
        totalGenerated: EXISTING_GENERATIONS + results.remaining,
        cleanup: { expiredInputs: inputs.deleted, expiredResults: results.deleted },
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("Could not load Pixora ImageKit stats", error);
    return Response.json(
      { totalGenerated: EXISTING_GENERATIONS },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
