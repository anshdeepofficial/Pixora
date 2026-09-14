import { deleteExpiredImageKitFiles, imageKitConfigured, listImageKitAssets } from "../../../lib/imagekit";
import { getVModelToken, vModelTokenFingerprint } from "../../../lib/vmodel-token";

const ORIGINAL_API_BASELINE = 300;
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
  const token = await getVModelToken();
  if (!token) {
    return Response.json(
      { totalGenerated: 0, creditsLeft: null },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  const fingerprint = vModelTokenFingerprint(token);
  const originalToken = process.env.VMODEL_API_TOKEN?.trim() || "";
  const isOriginalApi = Boolean(originalToken && token === originalToken);
  const baseline = isOriginalApi ? ORIGINAL_API_BASELINE : 0;
  const creditsLeftPromise = fetchVModelCreditsLeft(token);

  if (!imageKitConfigured()) {
    return Response.json(
      { totalGenerated: baseline, creditsLeft: await creditsLeftPromise },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  try {
    const countPath = `/pixora-counts/${fingerprint}/`;

    const [inputsCleanup, resultsCleanup, markers, creditsLeft] = await Promise.all([
      deleteExpiredImageKitFiles("/pixora-inputs/", ONE_HOUR),
      deleteExpiredImageKitFiles("/pixora-results/", ONE_DAY),
      listImageKitAssets(countPath, 1000),
      creditsLeftPromise,
    ]);

    return Response.json(
      {
        totalGenerated: baseline + markers.length,
        creditsLeft,
        apiFingerprint: fingerprint,
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
      { totalGenerated: baseline, creditsLeft: await creditsLeftPromise, apiFingerprint: fingerprint },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
