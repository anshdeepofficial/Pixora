import { allocateVModelTokenLeases } from "../../../lib/vmodel-token";

type PlanBody = { count?: number };

export async function POST(request: Request) {
  const body = await request.json() as PlanBody;
  const count = Number(body.count || 0);
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    return Response.json({ error: "Batch size must be between 1 and 50 images." }, { status: 400 });
  }

  try {
    const leases = await allocateVModelTokenLeases(count);
    if (leases.length !== count) {
      return Response.json({
        error: `Only ${leases.length} VModel generation slot${leases.length === 1 ? "" : "s"} are currently available for this ${count}-image batch.`,
        available: leases.length,
      }, { status: 503 });
    }
    return Response.json({ leases }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Could not prepare the batch.",
    }, { status: 500 });
  }
}
