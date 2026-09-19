import { cookies } from "next/headers";
import {
  PIXORA_SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  accountPasswordMatches,
  createAccount,
  createSessionToken,
  findAccountByEmail,
  readSessionToken,
  validateAccountCredentials,
} from "../../../lib/account-auth";

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

export async function GET() {
  const cookieStore = await cookies();
  const session = readSessionToken(cookieStore.get(PIXORA_SESSION_COOKIE)?.value);
  return Response.json(
    { authenticated: Boolean(session), account: session ? { email: session.email } : null },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

export async function POST(request: Request) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json() as { email?: string; password?: string };
  } catch {
    return Response.json({ error: "Invalid login request." }, { status: 400 });
  }

  const password = String(body.password || "");
  const validation = validateAccountCredentials(String(body.email || ""), password);
  if (validation.error) return Response.json({ error: validation.error }, { status: 400 });

  try {
    let account = await findAccountByEmail(validation.email);
    let created = false;

    if (account) {
      if (!accountPasswordMatches(account, password)) {
        return Response.json({ error: "Incorrect password for this email." }, { status: 401 });
      }
    } else {
      const result = await createAccount(validation.email, password);
      account = result.account;
      created = result.created;
      if (!created && !accountPasswordMatches(account, password)) {
        return Response.json({ error: "Incorrect password for this email." }, { status: 401 });
      }
    }

    const cookieStore = await cookies();
    cookieStore.set(PIXORA_SESSION_COOKIE, createSessionToken(account), sessionCookieOptions());

    return Response.json(
      {
        authenticated: true,
        created,
        account: { email: account.email },
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("Pixora account login failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not sign in." },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.set(PIXORA_SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return Response.json(
    { authenticated: false },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
