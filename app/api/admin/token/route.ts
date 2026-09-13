import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminSession } from "../../../../lib/admin-auth";
import { getVModelTokenInfo, saveVModelToken } from "../../../../lib/vmodel-token";

async function authorized() {
  const store = await cookies();
  return verifyAdminSession(store.get(ADMIN_COOKIE)?.value);
}

export async function GET() {
  if (!await authorized()) return Response.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return Response.json(await getVModelTokenInfo(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not read API key status." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  if (!await authorized()) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const body = await request.json() as { token?: string };
  const token = body.token?.trim() || "";
  if (token.length < 16 || token.length > 500 || /\s/.test(token)) return Response.json({ error: "Enter a valid VModel API key." }, { status: 400 });
  try {
    await saveVModelToken(token);
    return Response.json({ ok: true, masked: `••••••••${token.slice(-4)}`, source: "admin override" });
  } catch (error) {
    console.error("Could not save API key", error);
    return Response.json({ error: "Could not securely save the API key." }, { status: 500 });
  }
}
