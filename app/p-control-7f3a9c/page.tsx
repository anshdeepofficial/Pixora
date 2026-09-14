"use client";

import { FormEvent, useEffect, useState } from "react";

type TokenInfo = { configured: boolean; masked: string; source: string };
type TokenResponse = TokenInfo & { error?: string; cleared?: boolean };

export default function CredentialControl() {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadInfo() {
    const response = await fetch("/api/admin/token", { cache: "no-store" });
    if (response.status === 401) return;
    const data = await response.json() as TokenInfo;
    if (response.ok) { setUnlocked(true); setInfo(data); }
  }
  useEffect(() => { void loadInfo(); }, []);

  async function unlock(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    const response = await fetch("/api/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await response.json() as { error?: string };
    setBusy(false);
    if (!response.ok) return setMessage(data.error || "Could not unlock.");
    setUnlocked(true);
    await loadInfo();
    setPassword("");
  }

  async function updateToken(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    const response = await fetch("/api/admin/token", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = await response.json() as TokenResponse;
    setBusy(false);
    if (!response.ok) return setMessage(data.error || "Could not update the key.");
    setToken("");
    setInfo({ configured: Boolean(data.configured), masked: data.masked || "", source: data.source || "none" });
    if (data.cleared) {
      setMessage(data.configured
        ? "Saved API override cleared. Pixora is now using the Vercel VMODEL_API_TOKEN."
        : "Saved API override cleared. Add VMODEL_API_TOKEN in Vercel to enable generation.");
    } else {
      setMessage("API key updated. New generations will use it immediately.");
    }
  }

  return <main className="adminShell"><section className="adminCard">
    <div className="adminBrand"><span className="brandMark">P</span><div><strong>Pixora Control</strong><small>Private credential settings</small></div></div>
    {!unlocked ? <form onSubmit={unlock} autoComplete="on"><h1>Unlock settings</h1><p>Enter the admin password to manage the VModel connection.</p><input name="username" type="text" value="pixora-admin" autoComplete="username" readOnly tabIndex={-1} aria-hidden="true" style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none", overflow: "hidden" }} /><label htmlFor="admin-password">Admin password</label><input id="admin-password" name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /><button type="submit" disabled={busy}>{busy ? "Checking…" : "Unlock"}</button><small>Your browser can save this login and autofill it next time.</small></form>
      : <form onSubmit={updateToken}><h1>VModel API key</h1><p className="tokenStatus"><span className={info?.configured ? "online" : ""} />{info?.configured ? `Connected via ${info.source}` : "Not configured"}</p><label>Current key</label><div className="maskedToken">{info?.masked || "No key configured"}</div><label htmlFor="new-token">New API key (optional)</label><input id="new-token" name="vmodel-api-key" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" placeholder="Paste a new key, or leave blank" /><button type="submit" disabled={busy}>{busy ? "Saving…" : token.trim() ? "Save new API key" : "Use Vercel API key"}</button><small>Leave this field blank and press “Use Vercel API key” to remove the saved override and fall back to VMODEL_API_TOKEN from Vercel. The full current key is never sent to this browser.</small></form>}
    {message && <p className="adminMessage">{message}</p>}
  </section></main>;
}
