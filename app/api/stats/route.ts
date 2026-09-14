import { deleteExpiredImageKitFiles, imageKitConfigured } from "../../../lib/imagekit";
import { getVModelGenerationCount, getVModelTokenContext } from "../../../lib/vmodel-token";

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

async function fetchVModelCreditsLeft(token: string) {
  try {
    const response = await fetch("https://api.vmodel.ai/api/users/v1/account/credits/left", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({})) as { result?: number };
    return response.ok && typeof data.result === "number" ? data.result : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const context = await getVModelTokenContext();
  if (!context) {
    return Response.json(
      { totalGenerated: 0, creditsLeft: null },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  const countPromise = getVModelGenerationCount(context.fingerprint);
  const creditsLeftPromise = fetchVModelCreditsLeft(context.token);

  if (!imageKitConfigured()) {
    return Response.json(
      { totalGenerated: await countPromise, creditsLeft: await creditsLeftPromise, apiFingerprint: context.fingerprint },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  try {
    const [totalGenerated, creditsLeft, inputsCleanup, resultsCleanup] = await Promise.all([
      countPromise,
      creditsLeftPromise,
      deleteExpiredImageKitFiles("/pixora-inputs/", ONE_HOUR),
      deleteExpiredImageKitFiles("/pixora-results/", ONE_DAY),
    ]);

    return Response.json(
      {
        totalGenerated,
        creditsLeft,
        apiFingerprint: context.fingerprint,
        cleanup: {
          expiredInputs: inputsCleanup.deleted,
          expiredResults: resultsCleanup.deleted,
        },
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("Could not load Pixora stats", error);
    return Response.json(
      { totalGenerated: await countPromise, creditsLeft: await creditsLeftPromise, apiFingerprint: context.fingerprint },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
