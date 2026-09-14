import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminSession } from "../../../../lib/admin-auth";
import { clearVModelTokenOverride, getVModelTokenInfo, saveVModelToken } from "../../../../lib/vmodel-token";

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

  try {
    if (!token) {
      await clearVModelTokenOverride();
      const info = await getVModelTokenInfo();
      return Response.json({ ok: true, cleared: true, ...info });
    }

    if (token.length < 16 || token.length > 500 || /\s/.test(token)) {
      return Response.json({ error: "Enter a valid VModel API key, or leave it blank to use the Vercel environment key." }, { status: 400 });
    }

    await saveVModelToken(token);
    return Response.json({ ok: true, configured: true, masked: `••••••••${token.slice(-4)}`, source: "admin override" });
  } catch (error) {
    console.error("Could not update API key", error);
    return Response.json({ error: "Could not securely update the API key." }, { status: 500 });
  }
}
