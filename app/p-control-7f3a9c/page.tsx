"use client";

import { FormEvent, useEffect, useState } from "react";
type TokenInfo = { configured: boolean; masked: string; source: string };

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
    const data = await response.json();
    if (response.ok) { setUnlocked(true); setInfo(data); }
  }
  useEffect(() => { void loadInfo(); }, []);

  async function unlock(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    const response = await fetch("/api/admin/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    const data = await response.json(); setBusy(false);
    if (!response.ok) return setMessage(data.error || "Could not unlock.");
    setPassword(""); setUnlocked(true); await loadInfo();
  }

  async function updateToken(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    const response = await fetch("/api/admin/token", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    const data = await response.json(); setBusy(false);
    if (!response.ok) return setMessage(data.error || "Could not update the key.");
    setToken(""); setInfo({ configured: true, masked: data.masked, source: data.source });
    setMessage("API key updated. New generations will use it immediately.");
  }

  return <main className="adminShell"><section className="adminCard">
    <div className="adminBrand"><span className="brandMark">P</span><div><strong>Pixora Control</strong><small>Private credential settings</small></div></div>
    {!unlocked ? <form onSubmit={unlock}><h1>Unlock settings</h1><p>Enter the admin password to manage the VModel connection.</p><label htmlFor="admin-password">Admin password</label><input id="admin-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /><button disabled={busy}>{busy ? "Checking…" : "Unlock"}</button></form>
      : <form onSubmit={updateToken}><h1>VModel API key</h1><p className="tokenStatus"><span className={info?.configured ? "online" : ""} />{info?.configured ? `Connected via ${info.source}` : "Not configured"}</p><label>Current key</label><div className="maskedToken">{info?.masked || "No key configured"}</div><label htmlFor="new-token">Replace with a new key</label><input id="new-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="new-password" placeholder="Paste VModel API key" required /><button disabled={busy}>{busy ? "Saving…" : "Save new API key"}</button><small>The full current key is never sent to this browser.</small></form>}
    {message && <p className="adminMessage">{message}</p>}
  </section></main>;
}
