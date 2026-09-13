const HISTORY_VERSION = "2026-09-13T08:27:07.000Z";

export async function GET() {
  return Response.json(
    {
      history: [],
      historyVersion: HISTORY_VERSION,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
