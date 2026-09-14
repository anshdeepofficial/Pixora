import { deleteExpiredImageKitFiles, imageKitConfigured, listImageKitAssets } from "../../../lib/imagekit";
import { getVModelToken, vModelTokenFingerprint } from "../../../lib/vmodel-token";

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

export async function GET() {
  const token = await getVModelToken();
  if (!token) {
    return Response.json(
      { totalGenerated: 0 },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  if (!imageKitConfigured()) {
    return Response.json(
      { totalGenerated: 0 },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  try {
    const fingerprint = vModelTokenFingerprint(token);
    const resultPath = `/pixora-results/${fingerprint}/`;

    const [inputsCleanup, resultsCleanup] = await Promise.all([
      deleteExpiredImageKitFiles("/pixora-inputs/", ONE_HOUR),
      deleteExpiredImageKitFiles("/pixora-results/", ONE_DAY),
    ]);

    const currentKeyResults = await listImageKitAssets(resultPath, 1000);

    return Response.json(
      {
        totalGenerated: currentKeyResults.length,
        cleanup: {
          expiredInputs: inputsCleanup.deleted,
          expiredResults: resultsCleanup.deleted,
        },
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("Could not load Pixora ImageKit stats", error);
    return Response.json(
      { totalGenerated: 0 },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
