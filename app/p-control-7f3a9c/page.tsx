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
  activated?: boolean;
  activatedVercel?: boolean;
};

function stableApiOrder(apis: ApiInfo[]) {
  return [...apis].sort((left, right) => {
    if (left.source !== right.source) {
      if (left.source === "vercel") return -1;
      if (right.source === "vercel") return 1;
    }

    const leftTime = Date.parse(left.addedAt);
    const rightTime = Date.parse(right.addedAt);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return left.fingerprint.localeCompare(right.fingerprint);
  });
}

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

  async function saveApi(mode: "queue" | "activate") {
    const nextToken = token.trim();
    if (!nextToken) {
      setMessage("Paste a VModel API key first.");
      return;
    }

    setBusy(true);
    setMessage("");
    const response = await fetch("/api/admin/token", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: nextToken, activate: mode === "activate" }),
    });
    const data = await response.json() as TokenResponse;
    setBusy(false);
    if (!response.ok) return setMessage(data.error || "Could not update the API rotation.");

    setToken("");
    setInfo(data);
    if (mode === "activate") {
      setMessage(data.added
        ? "API saved and activated. New generation requests will use it immediately."
        : "Saved API activated. New generation requests will use it immediately.");
    } else {
      setMessage(data.added
        ? "API added to Queue. The current API stays active until it reaches 300 generations or you choose Use now."
        : "That API is already saved. Its existing position and generation count were kept.");
    }
  }

  async function activateVercelApi() {
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/admin/token", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "" }),
    });
    const data = await response.json() as TokenResponse;
    setBusy(false);
    if (!response.ok) return setMessage(data.error || "Could not activate the Vercel API.");
    setInfo(data);
    setMessage("Vercel API selected. New generation requests will use it immediately.");
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
  const apis = stableApiOrder(info?.apis || []);

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
      <form onSubmit={(event) => { event.preventDefault(); void saveApi("queue"); }}>
        <h1>VModel API rotation</h1>
        <p className="tokenStatus"><span className={info?.configured ? "online" : ""} />{info?.configured ? `Connected via ${info.source}` : "Not configured"}</p>
        <label>Currently active</label>
        <div className="maskedToken">{info?.masked || "No key configured"}</div>
        <label htmlFor="new-token">Add another API</label>
        <input id="new-token" name="vmodel-api-key" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" placeholder="Paste another VModel API key" />
        <div className="apiAddActions">
          <button type="submit" disabled={busy || !token.trim()}>{busy ? "Saving…" : "Add to Queue"}</button>
          <button type="button" className="secondaryApiAction" disabled={busy || !token.trim()} onClick={() => void saveApi("activate")}>{busy ? "Saving…" : "Use Now"}</button>
        </div>
        <button type="button" className="vercelApiAction" disabled={busy} onClick={() => void activateVercelApi()}>Use Vercel API key</button>
        <small><b>Add to Queue</b> keeps the current API active. <b>Use Now</b> saves the pasted API and switches to it immediately. Pixora automatically moves to the next queued API when the current one reaches {generationLimit} successful generations.</small>
      </form>

      <section className="apiRotation" aria-label="Saved VModel API rotation">
        <div className="apiRotationHead"><div><h2>API rotation</h2><p>{apis.length} saved {apis.length === 1 ? "API" : "APIs"} · numbering stays fixed in the order added</p></div><span>{generationLimit} max / API</span></div>
        {apis.length ? <div className="apiList">{apis.map((api, index) => {
          const current = api.status === "Currently using";
          const percent = Math.min(100, (api.generated / generationLimit) * 100);
          const displayStatus = api.status.startsWith("Queued") ? "Queued" : api.status;
          return <article key={api.fingerprint} className={current ? "current" : ""}>
            <div className="apiNumber">{index + 1}</div>
            <div className="apiDetails">
              <div className="apiLine"><strong>{api.masked}</strong><span className={`apiState ${current ? "active" : api.status.startsWith("Queued") ? "queued" : "previous"}`}>{displayStatus}</span></div>
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
