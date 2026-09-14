"use client";

import { FormEvent, useEffect, useState } from "react";

type ApiInfo = {
  fingerprint: string;
  masked: string;
  source: "vercel" | "saved";
  generated: number;
  status: "Currently using" | "Previously used" | "Used before previous" | "Queued next" | "Queued";
  addedAt: string;
};

type TokenInfo = {
  configured: boolean;
  masked: string;
  source: string;
  activeFingerprint?: string;
  generationLimit?: number;
  apis?: ApiInfo[];
};

type TokenResponse = TokenInfo & {
  error?: string;
  added?: boolean;
  activatedVercel?: boolean;
};

export default function CredentialControl() {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState("");

  async function loadInfo() {
    const response = await fetch("/api/admin/token", { cache: "no-store" });
    if (response.status === 401) return;
    const data = await response.json() as TokenInfo;
    if (response.ok) { setUnlocked(true); setInfo(data); }
  }

  useEffect(() => { void loadInfo(); }, []);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
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
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const addingToken = token.trim();
    const response = await fetch("/api/admin/token", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: addingToken }),
    });
    const data = await response.json() as TokenResponse;
    setBusy(false);
    if (!response.ok) return setMessage(data.error || "Could not update the API rotation.");
    setToken("");
    setInfo(data);

    if (!addingToken) {
      setMessage("Vercel API selected. If it has reached 300 generations, Pixora will automatically move to the next usable API.");
    } else if (data.added) {
      setMessage("API added to the rotation queue. Pixora will switch to it automatically when the active API reaches 300 generations.");
    } else {
      setMessage("That API is already saved in the rotation list.");
    }
  }

  async function activateApi(fingerprint: string) {
    setSwitching(fingerprint);
    setMessage("");
    const response = await fetch("/api/admin/token", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint }),
    });
    const data = await response.json() as TokenResponse;
    setSwitching("");
    if (!response.ok) return setMessage(data.error || "Could not activate this API.");
    setInfo(data);
    setMessage("API switched. New generation requests will use this key immediately.");
  }

  const generationLimit = info?.generationLimit || 300;
  const apis = info?.apis || [];

  return <main className="adminShell"><section className="adminCard">
    <div className="adminBrand"><span className="brandMark">P</span><div><strong>Pixora Control</strong><small>Private credential settings</small></div></div>

    {!unlocked ? <form onSubmit={unlock} autoComplete="on">
      <h1>Unlock settings</h1>
      <p>Enter the admin password to manage the VModel connection.</p>
      <input name="username" type="text" value="pixora-admin" autoComplete="username" readOnly tabIndex={-1} aria-hidden="true" className="passwordManagerUser" />
      <label htmlFor="admin-password">Admin password</label>
      <input id="admin-password" name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
      <button type="submit" disabled={busy}>{busy ? "Checking…" : "Unlock"}</button>
      <small>Your browser can save this login and autofill it next time.</small>
    </form> : <>
      <form onSubmit={updateToken}>
        <h1>VModel API rotation</h1>
        <p className="tokenStatus"><span className={info?.configured ? "online" : ""} />{info?.configured ? `Connected via ${info.source}` : "Not configured"}</p>
        <label>Currently active</label>
        <div className="maskedToken">{info?.masked || "No key configured"}</div>
        <label htmlFor="new-token">Add next API</label>
        <input id="new-token" name="vmodel-api-key" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" placeholder="Paste another VModel API key" />
        <button type="submit" disabled={busy}>{busy ? "Saving…" : token.trim() ? "Add API to rotation" : "Use Vercel API key"}</button>
        <small>Added APIs are kept securely and queued. Pixora automatically moves to the next usable API at {generationLimit} successful generations.</small>
      </form>

      <section className="apiRotation" aria-label="Saved VModel API rotation">
        <div className="apiRotationHead"><div><h2>API rotation</h2><p>{apis.length} saved {apis.length === 1 ? "API" : "APIs"}</p></div><span>{generationLimit} max / API</span></div>
        {apis.length ? <div className="apiList">{apis.map((api, index) => {
          const current = api.status === "Currently using";
          const percent = Math.min(100, (api.generated / generationLimit) * 100);
          return <article key={api.fingerprint} className={current ? "current" : ""}>
            <div className="apiNumber">{index + 1}</div>
            <div className="apiDetails">
              <div className="apiLine"><strong>{api.masked}</strong><span className={`apiState ${current ? "active" : api.status.startsWith("Queued") ? "queued" : "previous"}`}>{api.status}</span></div>
              <div className="apiCount"><span>{api.generated} / {generationLimit} generated</span><b>{Math.max(0, generationLimit - api.generated)} left</b></div>
              <div className="apiMeter"><i style={{ width: `${percent}%` }} /></div>
            </div>
            {!current && <button type="button" className="useApi" disabled={Boolean(switching)} onClick={() => void activateApi(api.fingerprint)}>{switching === api.fingerprint ? "Switching…" : "Use now"}</button>}
          </article>;
        })}</div> : <p className="emptyApis">No API keys are saved yet.</p>}
      </section>
    </>}

    {message && <p className="adminMessage">{message}</p>}
  </section></main>;
}
