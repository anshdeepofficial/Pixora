import { cookies } from "next/headers";
import { ADMIN_COOKIE, verifyAdminSession } from "../../../../lib/admin-auth";
import {
  activateVModelToken,
  clearVModelTokenOverride,
  getVModelTokenInfo,
  queueVModelToken,
} from "../../../../lib/vmodel-token";

async function authorized() {
  const store = await cookies();
  return verifyAdminSession(store.get(ADMIN_COOKIE)?.value);
}

export async function GET() {
  if (!await authorized()) return Response.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return Response.json(await getVModelTokenInfo(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not read API key status", error);
    return Response.json({ error: "Could not read API key status." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  if (!await authorized()) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const body = await request.json() as { token?: string; activate?: boolean };
  const token = body.token?.trim() || "";

  try {
    if (!token) {
      await clearVModelTokenOverride();
      return Response.json({ ok: true, activatedVercel: true, ...(await getVModelTokenInfo()) });
    }

    if (token.length < 16 || token.length > 500 || /\s/.test(token)) {
      return Response.json({ error: "Enter a valid VModel API key." }, { status: 400 });
    }

    const queued = await queueVModelToken(token);
    if (body.activate) {
      const info = await activateVModelToken(queued.fingerprint);
      return Response.json({ ok: true, added: queued.added, activated: true, ...info });
    }

    return Response.json({ ok: true, added: queued.added, activated: false, ...queued.info });
  } catch (error) {
    console.error("Could not update API rotation", error);
    return Response.json({ error: error instanceof Error ? error.message : "Could not securely update the API rotation." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  if (!await authorized()) return Response.json({ error: "Unauthorized." }, { status: 401 });
  const body = await request.json() as { fingerprint?: string };
  const fingerprint = body.fingerprint?.trim() || "";
  if (!/^[a-f0-9]{20}$/.test(fingerprint)) return Response.json({ error: "Invalid API selection." }, { status: 400 });

  try {
    return Response.json({ ok: true, ...(await activateVModelToken(fingerprint)) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not activate this API." }, { status: 400 });
  }
}
