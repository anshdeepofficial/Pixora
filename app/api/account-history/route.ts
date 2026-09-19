import { cookies } from "next/headers";
import {
  PIXORA_SESSION_COOKIE,
  clearAccountHistory,
  deleteAccountHistoryItem,
  getAccountHistory,
  readSessionToken,
  saveAccountHistoryItem,
} from "../../../lib/account-auth";

async function sessionFromRequest() {
  const cookieStore = await cookies();
  return readSessionToken(cookieStore.get(PIXORA_SESSION_COOKIE)?.value);
}

export async function GET() {
  const session = await sessionFromRequest();
  if (!session) return Response.json({ error: "Sign in to sync history." }, { status: 401 });

  try {
    const history = await getAccountHistory(session.id);
    return Response.json(
      { history, retentionMinutes: 60 },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("Could not load Pixora account history", error);
    return Response.json({ error: "Could not load synced history." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await sessionFromRequest();
  if (!session) return Response.json({ error: "Sign in to sync history." }, { status: 401 });

  let body: { url?: string; previewUrl?: string; prompt?: string; createdAt?: string };
  try {
    body = await request.json() as { url?: string; previewUrl?: string; prompt?: string; createdAt?: string };
  } catch {
    return Response.json({ error: "Invalid history item." }, { status: 400 });
  }

  try {
    const item = await saveAccountHistoryItem(session.id, {
      url: String(body.url || ""),
      previewUrl: body.previewUrl ? String(body.previewUrl) : undefined,
      prompt: String(body.prompt || ""),
      createdAt: String(body.createdAt || new Date().toISOString()),
    });
    return Response.json({ item });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not save history." },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request) {
  const session = await sessionFromRequest();
  if (!session) return Response.json({ error: "Sign in to sync history." }, { status: 401 });

  const url = new URL(request.url).searchParams.get("url");
  try {
    const deleted = url
      ? await deleteAccountHistoryItem(session.id, url)
      : await clearAccountHistory(session.id);
    return Response.json({ deleted });
  } catch (error) {
    console.error("Could not delete Pixora account history", error);
    return Response.json({ error: "Could not update synced history." }, { status: 500 });
  }
}
