"use client";

import { ChangeEvent, DragEvent, useEffect, useRef, useState } from "react";

const ratios = ["default", "1:1", "3:2", "2:3", "9:16", "16:9", "3:4", "4:3"];

type HistoryItem = { url: string; prompt: string; createdAt: string };

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadSequence = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState("default");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<"result" | "history">("result");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [uploadedUrl, setUploadedUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [downloadMenu, setDownloadMenu] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const prune = () => {
      const saved = localStorage.getItem("pixora-history");
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const fresh: HistoryItem[] = saved ? (JSON.parse(saved) as HistoryItem[]).filter((item) => new Date(item.createdAt).getTime() > cutoff) : [];
      setHistory(fresh);
      localStorage.setItem("pixora-history", JSON.stringify(fresh));
    };
    prune();
    const timer = window.setInterval(prune, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  async function uploadImage(image: File) {
    const upload = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": image.type, "X-File-Name": encodeURIComponent(image.name) },
      body: image,
    });
    const uploaded = await upload.json() as { url?: string; error?: string };
    if (!upload.ok || !uploaded.url) throw new Error(uploaded.error || "Upload failed");
    return uploaded.url;
  }

  function chooseFile(next?: File) {
    if (!next || !next.type.startsWith("image/")) return;
    if (preview) URL.revokeObjectURL(preview);
    setFile(next);
    setPreview(URL.createObjectURL(next));
    setResult("");
    setMessage("");
    setUploadedUrl("");
    const sequence = ++uploadSequence.current;
    setUploading(true);
    uploadImage(next).then((url) => {
      if (sequence === uploadSequence.current) setUploadedUrl(url);
    }).catch((error) => {
      if (sequence === uploadSequence.current) setMessage(error instanceof Error ? error.message : "Upload failed");
    }).finally(() => {
      if (sequence === uploadSequence.current) setUploading(false);
    });
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    chooseFile(event.dataTransfer.files[0]);
  }

  async function generate() {
    if (!file || !prompt.trim()) return;
    setBusy(true);
    setMessage(uploadedUrl ? "Creating your edit with V-Editor…" : "Finishing your secure upload…");
    setTab("result");
    try {
      const imageUrl = uploadedUrl || await uploadImage(file);
      setUploadedUrl(imageUrl);
      setMessage("Creating your edit with V-Editor…");
      const create = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl, prompt: prompt.trim(), aspectRatio: ratio }),
      });
      const created = await create.json() as { taskId?: string; error?: string };
      if (!create.ok || !created.taskId) throw new Error(created.error || "Could not start generation");

      for (let attempt = 0; attempt < 90; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const statusResponse = await fetch(`/api/task?id=${encodeURIComponent(created.taskId)}`);
        const status = await statusResponse.json() as { status?: string; output?: string[]; error?: string };
        if (status.status === "succeeded" && status.output?.[0]) {
          const item = { url: status.output[0], prompt: prompt.trim(), createdAt: new Date().toISOString() };
          setResult(item.url);
          setHistory((current) => {
            const next = [item, ...current].slice(0, 12);
            localStorage.setItem("pixora-history", JSON.stringify(next));
            return next;
          });
          setMessage("");
          return;
        }
        if (status.status === "failed") throw new Error(status.error || "Generation failed");
        setMessage(attempt < 3 ? "The model is warming up…" : "Adding the finishing details…");
      }
      throw new Error("Generation took too long. Please try again.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function fetchImage(url: string) {
    const response = await fetch(`/api/download?url=${encodeURIComponent(url)}`);
    if (!response.ok) throw new Error("Could not download this image.");
    return response.blob();
  }

  function saveBlob(blob: Blob, name: string) {
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  async function downloadOne(url: string, index = 1) {
    const blob = await fetchImage(url);
    const extension = blob.type.includes("jpeg") ? "jpg" : blob.type.includes("webp") ? "webp" : "png";
    saveBlob(blob, `pixora-${index}.${extension}`);
  }

  async function downloadSelected(mode: "zip" | "separate") {
    if (!selected.length) return;
    setDownloading(true);
    setDownloadMenu(false);
    try {
      if (mode === "separate") {
        for (let index = 0; index < selected.length; index++) await downloadOne(selected[index], index + 1);
      } else {
        const JSZip = (await import("jszip")).default;
        const zip = new JSZip();
        await Promise.all(selected.map(async (url, index) => {
          const blob = await fetchImage(url);
          const extension = blob.type.includes("jpeg") ? "jpg" : blob.type.includes("webp") ? "webp" : "png";
          zip.file(`pixora-${index + 1}.${extension}`, blob);
        }));
        saveBlob(await zip.generateAsync({ type: "blob" }), "pixora-images.zip");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  function toggleSelection(url: string) {
    setSelected((current) => current.includes(url) ? current.filter((item) => item !== url) : [...current, url]);
  }

  return (
    <main className="shell">
      <nav className="nav">
        <a className="brand" href="#top" aria-label="Pixora home"><span className="brandMark">P</span><span>Pixora</span></a>
        <div className="navActions"><span className="statusDot"><i /> V-Editor connected</span><a href="#how">How it works</a><a className="support" href="mailto:support@example.com">Support</a></div>
      </nav>

      <section className="hero" id="top">
        <div className="eyebrow"><span>✦</span> AI PHOTO EDITOR</div>
        <h1>Edit any photo.<br /><em>Just describe it.</em></h1>
        <p>Professional image transformations powered by V-Editor. No layers, no learning curve—just your idea and one prompt.</p>
        <div className="unlimited"><span>∞</span><div><strong>Unlimited trials</strong><small>Explore freely during early access</small></div></div>
      </section>

      <section className="studio" aria-label="AI photo editor">
        <div className="studioTop"><div><span className="step">01</span><h2>Add your image</h2></div><span className="privacy">◆ Private by design</span></div>
        <div className="workspace">
          <div className={`dropzone ${preview ? "hasImage" : ""}`} onClick={() => inputRef.current?.click()} onDrop={onDrop} onDragOver={(e) => e.preventDefault()} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}>
            <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => chooseFile(e.target.files?.[0])} />
            {preview ? <><img src={preview} alt="Selected preview" /><button className="replace" onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}>Replace image</button></> : <div className="uploadEmpty"><span className="uploadIcon">↥</span><h3>Drop an image here</h3><p>or click to browse · PNG, JPG or WEBP</p><button>Choose image</button></div>}
          </div>

          <div className="controls">
            <div className="controlHeading"><span className="step">02</span><h2>Describe your edit</h2></div>
            <label className="promptLabel" htmlFor="prompt">YOUR PROMPT</label>
            <textarea id="prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Make the scene look like golden hour, keep the person unchanged…" maxLength={700} />
            <div className="promptMeta"><button onClick={() => setPrompt("Replace the background with a warm, cinematic sunset while keeping the subject unchanged.")}>✦ Try an example</button><span>{prompt.length}/700</span></div>
            <div className="ratioPanel">
              <div className="ratioLabel"><div><span>OUTPUT FORMAT</span><small>Choose the perfect canvas</small></div><strong>{ratio === "default" ? "Original" : ratio}</strong></div>
              <div className="ratios">{ratios.map((item) => <button key={item} className={ratio === item ? "active" : ""} onClick={() => setRatio(item)} aria-label={`Use ${item === "default" ? "original" : item} aspect ratio`}><i className={`ratioShape ratio-${item.replace(":", "x")}`} />{item === "default" ? "Auto" : item}</button>)}</div>
            </div>
            <button className="generate" disabled={!file || !prompt.trim() || busy} onClick={generate}>{busy ? <><span className="spinner" /> {message}</> : <>{uploading ? "Preparing image…" : "Generate edit"} <span>→</span></>}</button>
            {!busy && message && <p className="error">{message}</p>}
            <p className="fineprint">Unlimited access · History automatically clears after 24 hours</p>
          </div>
        </div>

        <div className="output">
          <div className="tabs"><button className={tab === "result" ? "active" : ""} onClick={() => setTab("result")}>Result</button><button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>24h History <span>{history.length}</span></button></div>
          {tab === "history" && history.length > 0 && <div className="downloadBar">
            <div><button className={`selectToggle ${selecting ? "active" : ""}`} onClick={() => { setSelecting(!selecting); setSelected([]); setDownloadMenu(false); }}>{selecting ? "Done" : "Select"}</button>{selecting && <button className="selectAll" onClick={() => setSelected(selected.length === history.length ? [] : history.map((item) => item.url))}>{selected.length === history.length ? "Clear all" : "Select all"}</button>}</div>
            {selecting && <div className="downloadWrap"><button className="downloadSelected" disabled={!selected.length || downloading} onClick={() => setDownloadMenu(!downloadMenu)}>{downloading ? "Preparing…" : `Download ${selected.length || ""}`} <span>⌄</span></button>{downloadMenu && <div className="downloadMenu"><button onClick={() => downloadSelected("zip")}><b>ZIP archive</b><small>One file with all selected images</small></button><button onClick={() => downloadSelected("separate")}><b>Separate files</b><small>Download every image individually</small></button></div>}</div>}
          </div>}
          {tab === "result" ? <div className="resultArea">{result ? <div className="resultCard"><img src={result} alt="AI generated edit" /><div className="resultActions"><button onClick={() => downloadOne(result)}>↓ Download</button><a href={result} target="_blank" rel="noreferrer">Open full size ↗</a></div></div> : <div className="emptyResult"><span>✦</span><h3>Your creation will appear here</h3><p>Upload an image, write a prompt, and let Pixora do the rest.</p></div>}</div> : <div className={`historyGrid ${selecting ? "selecting" : ""}`}>{history.length ? history.map((item) => <article key={item.createdAt} className={selected.includes(item.url) ? "selected" : ""} onClick={() => selecting ? toggleSelection(item.url) : (setResult(item.url), setTab("result"))} role="button" tabIndex={0} onKeyDown={(event) => event.key === "Enter" && (selecting ? toggleSelection(item.url) : (setResult(item.url), setTab("result")))}>{selecting && <span className="check">{selected.includes(item.url) ? "✓" : ""}</span>}<img src={item.url} alt={item.prompt} /><div className="historyCaption"><span>{item.prompt}</span>{!selecting && <button aria-label="Download image" onClick={(event) => { event.stopPropagation(); downloadOne(item.url); }}>↓</button>}</div></article>) : <div className="emptyResult"><h3>No edits yet</h3><p>Edits stay on this device for 24 hours.</p></div>}</div>}
        </div>
      </section>

      <section className="how" id="how"><p className="eyebrow">A BETTER WAY TO EDIT</p><h2>From idea to image<br />in three simple steps.</h2><div className="howGrid"><article><span>01</span><h3>Upload</h3><p>Choose any portrait, product shot, interior, or landscape.</p></article><article><span>02</span><h3>Describe</h3><p>Tell the editor exactly what should change—and what should stay.</p></article><article><span>03</span><h3>Create</h3><p>Get a polished, high-quality edit ready to download and share.</p></article></div></section>
      <footer><a className="brand" href="#top"><span className="brandMark">P</span><span>Pixora</span></a><p>AI editing, without the complexity.</p><span>Powered by VModel V-Editor</span></footer>
    </main>
  );
}
