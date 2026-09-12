export async function GET(request: Request) {
  const token = process.env.VMODEL_API_TOKEN;
  if (!token) return Response.json({ error: "VModel API is not configured." }, { status: 503 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !/^[a-zA-Z0-9_-]{6,80}$/.test(id)) return Response.json({ error: "Invalid task ID." }, { status: 400 });

  const response = await fetch(`https://api.vmodel.ai/api/tasks/v1/get/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  const data = await response.json() as { result?: { status?: string; output?: string[]; error?: string } };
  if (!response.ok || !data.result) return Response.json({ error: "Could not check generation." }, { status: 502 });
  return Response.json({ status: data.result.status, output: data.result.output, error: data.result.error });
}
