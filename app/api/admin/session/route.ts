import { createAdminSession, verifyAdminPassword } from "../../../../lib/admin-auth";

export async function POST(request: Request) {
  const body = await request.json() as { password?: string };
  if (!body.password || !verifyAdminPassword(body.password)) return Response.json({ error: "Incorrect password." }, { status: 401 });
  const response = Response.json({ ok: true });
  response.headers.append("Set-Cookie", `pixora_admin=${createAdminSession()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=1800`);
  return response;
}

export async function DELETE() {
  const response = Response.json({ ok: true });
  response.headers.append("Set-Cookie", "pixora_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
  return response;
}
