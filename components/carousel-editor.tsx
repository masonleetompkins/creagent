"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadImage, renderSlide } from "@/lib/carousel-render";
import { BODY_FONTS, HEADING_FONTS, fontById } from "@/lib/fonts";

type Project = {
  id: string;
  slot_id: string | null;
  title: string;
  primary_color: string;
  secondary_color: string;
  background_color: string;
  heading_font: string;
  body_font: string;
};

type Slide = {
  id: string;
  position: number;
  layout: string;
  heading: string;
  body: string;
  image_path: string | null;
  image_source: string | null;
  image_prompt: string | null;
};

type Photo = {
  asset_id: string;
  title: string | null;
  source: string;
  url: string;
  tag: { description: string; tags: string } | null;
};

type GenRequest = {
  id: string;
  slide_id: string | null;
  prompt: string;
  status: string;
  created_at: string;
};

const LAYOUTS = ["cover", "content", "photo", "cta"];

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  return data;
}

async function pollJob(jobId: string): Promise<Record<string, unknown>> {
  for (;;) {
    const data = await readJson(await fetch(`/api/jobs/${jobId}`));
    if (data.state === "completed" || data.state === "failed") return data;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export default function CarouselEditor({ projectId }: { projectId: string }): React.ReactNode {
  const [project, setProject] = useState<Project | null>(null);
  const [slides, setSlides] = useState<Slide[]>([]);
  const [requests, setRequests] = useState<GenRequest[]>([]);
  const [sel, setSel] = useState(0);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kit, setKit] = useState({ title: "", primary: "#0b5fff", secondary: "#111111", background: "#ffffff", heading: "system-black", body: "system" });
  const [draft, setDraft] = useState({ layout: "content", heading: "", body: "" });
  const [brief, setBrief] = useState("");
  const [count, setCount] = useState("");
  const [imgPrompt, setImgPrompt] = useState("");
  const [imgTick, setImgTick] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await readJson(await fetch(`/api/carousels/${projectId}`));
      const p = data.project as Project;
      const s = (data.slides as Slide[]) ?? [];
      setProject(p);
      setSlides(s);
      setKit({
        title: p.title,
        primary: p.primary_color,
        secondary: p.secondary_color,
        background: p.background_color,
        heading: p.heading_font,
        body: p.body_font,
      });
      setSel((i) => Math.min(i, Math.max(0, s.length - 1)));
      setRequests((data.gen_requests as GenRequest[]) ?? []);
      const ph = await readJson(await fetch("/api/photos"));
      setPhotos(((ph.photos as Photo[]) ?? []).slice(0, 24));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onAgent = (e: Event): void => {
      const d = (e as CustomEvent<{ kind?: string; entityId?: string }>).detail;
      if (d?.kind === "carousel" && d.entityId === projectId) void load();
    };
    window.addEventListener("creagent:agent-updated", onAgent);
    return () => {
      window.removeEventListener("creagent:agent-updated", onAgent);
    };
  }, [load, projectId]);

  const current = slides[sel] ?? null;

  useEffect(() => {
    if (current) {
      setDraft({ layout: current.layout, heading: current.heading, body: current.body });
      setImgPrompt(current.image_prompt ?? "");
    }
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live preview render.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!current) {
      canvas.width = 1080;
      canvas.height = 1350;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = kit.background || "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = kit.secondary || "#111111";
        ctx.globalAlpha = 0.55;
        ctx.font = "600 44px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Add a slide to start", canvas.width / 2, canvas.height / 2);
        ctx.globalAlpha = 1;
      }
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const image = current.image_path
          ? await loadImage(`/api/carousels/slides/${current.id}/image?cb=${imgTick}`).catch(() => null)
          : null;
        if (cancelled) return;
        await renderSlide(
          canvas,
          { layout: draft.layout, heading: draft.heading, body: draft.body, image },
          {
            primary: kit.primary,
            secondary: kit.secondary,
            background: kit.background,
            headingFont: fontById(HEADING_FONTS, kit.heading),
            bodyFont: fontById(BODY_FONTS, kit.body),
          },
        );
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [current?.id, current?.image_path, draft, kit, imgTick]);

  async function saveKit(): Promise<void> {
    try {
      const data = await readJson(
        await fetch(`/api/carousels/${projectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: kit.title,
            primary_color: kit.primary,
            secondary_color: kit.secondary,
            background_color: kit.background,
            heading_font: kit.heading,
            body_font: kit.body,
          }),
        }),
      );
      setProject(data.project as Project);
      setNote("Brand kit saved.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveSlide(): Promise<void> {
    if (!current) return;
    try {
      await readJson(
        await fetch(`/api/carousels/slides/${current.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ layout: draft.layout, heading: draft.heading, body: draft.body }),
        }),
      );
      await load();
      setNote("Slide saved.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function runAgentJob(url: string, body: unknown, label: string): Promise<void> {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const started = await readJson(
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      const done = await pollJob(started.jobId as string);
      if (done.state === "failed") throw new Error((done.failedReason as string) ?? "job failed");
      setNote(`${label}: ${JSON.stringify(done.result ?? {}).slice(0, 300)}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function decideRequest(id: string, decision: "approve" | "reject"): Promise<void> {
    try {
      await readJson(await fetch(`/api/gen-requests/${id}/${decision}`, { method: "POST" }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function runCopyJob(replace: boolean): Promise<void> {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const started = await readJson(
        await fetch(`/api/carousels/${projectId}/generate-copy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ numSlides: slides.length || 7, brief, replace }),
        }),
      );
      const done = await pollJob(started.jobId as string);
      if (done.state === "failed") throw new Error((done.failedReason as string) ?? "copy job failed");
      setNote(`Copy ready: ${JSON.stringify(done.result ?? {})}`);
      setSel(0);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runImageJob(): Promise<void> {
    if (!current || !imgPrompt.trim()) return;
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const started = await readJson(
        await fetch(`/api/carousels/slides/${current.id}/generate-image`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: imgPrompt }),
        }),
      );
      const done = await pollJob(started.jobId as string);
      if (done.state === "failed") throw new Error((done.failedReason as string) ?? "image job failed");
      setNote("Image generated.");
      setImgTick((t) => t + 1);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addSlide(): Promise<void> {
    try {
      await readJson(
        await fetch(`/api/carousels/${projectId}/slides`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );
      await load();
      setSel(slides.length);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteSlide(id: string): Promise<void> {
    try {
      await readJson(await fetch(`/api/carousels/slides/${id}`, { method: "DELETE" }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function move(dir: -1 | 1): Promise<void> {
    if (!current) return;
    const j = sel + dir;
    if (j < 0 || j >= slides.length) return;
    const ids = slides.map((s) => s.id);
    [ids[sel], ids[j]] = [ids[j], ids[sel]];
    try {
      await readJson(
        await fetch(`/api/carousels/${projectId}/reorder`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderedIds: ids }),
        }),
      );
      setSel(j);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function applyCount(): Promise<void> {
    const n = Math.max(1, Math.min(Number(count) || 0, 15));
    if (n === 0 || n === slides.length) return;
    if (n < slides.length && !window.confirm(`Trim to ${n} slides? Trailing slides are deleted.`)) return;
    try {
      await readJson(
        await fetch(`/api/carousels/${projectId}/set-count`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ count: n }),
        }),
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function usePhoto(assetId: string, url: string): Promise<void> {
    if (!current) return;
    try {
      await readJson(
        await fetch(`/api/carousels/slides/${current.id}/use-photo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assetId, url }),
        }),
      );
      setImgTick((t) => t + 1);
      await load();
      setNote("Photo attached.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function uploadImage(file: File | undefined): Promise<void> {
    if (!current || !file) return;
    try {
      const form = new FormData();
      form.append("file", file);
      await readJson(
        await fetch(`/api/carousels/slides/${current.id}/upload`, { method: "POST", body: form }),
      );
      setImgTick((t) => t + 1);
      await load();
      setNote("Upload attached.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function download(canvas: HTMLCanvasElement, name: string): void {
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = name;
    a.click();
  }

  async function exportCurrent(): Promise<void> {
    if (canvasRef.current && current) download(canvasRef.current, `slide-${sel + 1}.png`);
  }

  async function exportAll(): Promise<void> {
    setBusy(true);
    try {
      const off = document.createElement("canvas");
      for (let i = 0; i < slides.length; i++) {
        const s = slides[i];
        const image = s.image_path ? await loadImage(`/api/carousels/slides/${s.id}/image`).catch(() => null) : null;
        await renderSlide(
          off,
          { layout: s.layout, heading: s.heading, body: s.body, image },
          {
            primary: kit.primary,
            secondary: kit.secondary,
            background: kit.background,
            headingFont: fontById(HEADING_FONTS, kit.heading),
            bodyFont: fontById(BODY_FONTS, kit.body),
          },
        );
        download(off, `slide-${i + 1}.png`);
        await new Promise((r) => setTimeout(r, 400));
      }
      setNote(`Exported ${slides.length} PNGs.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!project) return <p className="muted">{error ?? "Loading…"}</p>;

  return (
    <>
      {note ? <p className="note ok">{note}</p> : null}
      {error ? <p className="note err">{error}</p> : null}

      <section className="keycard">
        <div className="row" style={{ marginTop: 0 }}>
          <input type="text" aria-label="Title" value={kit.title} onChange={(e) => setKit({ ...kit, title: e.target.value })} />
          <label>Pri <input type="color" value={kit.primary} onChange={(e) => setKit({ ...kit, primary: e.target.value })} /></label>
          <label>Sec <input type="color" value={kit.secondary} onChange={(e) => setKit({ ...kit, secondary: e.target.value })} /></label>
          <label>Bg <input type="color" value={kit.background} onChange={(e) => setKit({ ...kit, background: e.target.value })} /></label>
          <select aria-label="Heading font" value={kit.heading} onChange={(e) => setKit({ ...kit, heading: e.target.value })}>
            {HEADING_FONTS.map((f) => (
              <option key={f.id} value={f.id}>Head: {f.label}</option>
            ))}
          </select>
          <select aria-label="Body font" value={kit.body} onChange={(e) => setKit({ ...kit, body: e.target.value })}>
            {BODY_FONTS.map((f) => (
              <option key={f.id} value={f.id}>Body: {f.label}</option>
            ))}
          </select>
          <button className="primary" onClick={() => void saveKit()}>Save kit</button>
        </div>
      </section>

      <div className="toolbar">
        <button className="primary" disabled={busy} onClick={() => void runCopyJob(false)}>
          Generate copy
        </button>
        <button disabled={busy} onClick={() => void runCopyJob(true)}>Replace</button>
        <button disabled={busy} onClick={() => void runAgentJob(`/api/carousels/${projectId}/autopick`, {}, "Auto-picked")}>
          Auto-pick photos
        </button>
        <button disabled={busy} onClick={() => void runAgentJob(`/api/carousels/${projectId}/plan-images`, {}, "Planned")}>
          Plan images
        </button>
        <span className="spacer" />
        <button onClick={() => void addSlide()}>+ Slide</button>
        <label className="steplabel">
          Slides
          <input
            type="number"
            aria-label="Slide count"
            min={1}
            max={15}
            placeholder={String(slides.length || 7)}
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        </label>
        <button onClick={() => void applyCount()}>Apply</button>
      </div>
      <div className="row">
        <input type="text" aria-label="Brief" placeholder="Brief for the model (optional)" value={brief} onChange={(e) => setBrief(e.target.value)} />
      </div>

      <div className="edgrid work">
        <div>
          <h2>Slides ({slides.length})</h2>
          <div className="ced-slides">
            {slides.map((s, i) => (
              <button key={s.id} className={`slot ${i === sel ? "sel" : ""}`} onClick={() => setSel(i)}>
                {s.image_path ? (
                  <img
                    className="ced-thumb"
                    src={`/api/carousels/slides/${s.id}/image`}
                    alt=""
                    loading="lazy"
                  />
                ) : null}
                <span className="slottime">{i + 1}</span>
                <span className="slotmain">
                  [{s.layout}] {(s.heading || "(no heading)").slice(0, 28)}
                </span>
                <span className="slotsub">{s.image_path ? `img: ${s.image_source}` : "no image"}</span>
              </button>
            ))}
          </div>
        </div>
        <div>
            <section className="keycard" style={{ marginTop: 0 }}>
              <canvas ref={canvasRef} className="preview" />
              {current ? (
              <>
              <div className="row">
                <button disabled={busy} onClick={() => void exportCurrent()}>Export PNG</button>
                <button disabled={busy || slides.length === 0} onClick={() => void exportAll()}>Export all</button>
                <select aria-label="Layout" value={draft.layout} onChange={(e) => setDraft({ ...draft, layout: e.target.value })}>
                  {LAYOUTS.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
                <button onClick={() => void move(-1)}>↑</button>
                <button onClick={() => void move(1)}>↓</button>
                <button onClick={() => void deleteSlide(current.id)}>Delete</button>
              </div>
              <div className="row">
                <input type="text" aria-label="Heading" placeholder={`Slide ${sel + 1} heading`} value={draft.heading} onChange={(e) => setDraft({ ...draft, heading: e.target.value })} />
              </div>
              <div className="row">
                <textarea aria-label="Body" rows={4} placeholder="Body" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
              </div>
              <div className="row">
                <button className="primary" onClick={() => void saveSlide()}>Save slide</button>
              </div>
              </>
              ) : null}
            </section>
          {current ? (
            <section className="keycard">
              {(() => {
            const req = requests
              .filter((r) => r.slide_id === current.id)
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] ?? null;
            if (!req) return null;
            if (req.status !== "pending") {
              return <p className="muted">Image request {req.status}.</p>;
            }
            return (
              <div>
                <p className="note">Agent requested a generated image: {req.prompt}</p>
                <div className="row">
                  <button className="primary" onClick={() => void decideRequest(req.id, "approve")}>
                    Approve + generate
                  </button>
                  <button onClick={() => void decideRequest(req.id, "reject")}>Reject</button>
                </div>
              </div>
            );
          })()}
              <h2>Image</h2>
          <div className="row">
            <input type="text" aria-label="Image prompt" placeholder="Describe the scene for Muse Image" value={imgPrompt} onChange={(e) => setImgPrompt(e.target.value)} />
            <button disabled={busy || !imgPrompt.trim()} onClick={() => void runImageJob()}>Generate</button>
          </div>
          <div className="row">
            <input type="file" accept="image/*" aria-label="Upload image" onChange={(e) => { void uploadImage(e.target.files?.[0]); e.target.value = ""; }} />
          </div>
          <div className="row">
            <button disabled={busy} onClick={() => void runAgentJob("/api/photos/scan", {}, "Photo scan")}>
              Analyze photos
            </button>
            <span className="muted">
              {photos.filter((p) => p.tag).length}/{photos.length} analyzed
            </span>
          </div>
          <div className="photogrid">
            {photos.map((p) => (
              <button
                key={`${p.asset_id}-${p.url}`}
                className={`photo${p.tag ? " tagged" : ""}`}
                onClick={() => void usePhoto(p.asset_id, p.url)}
                title={p.tag ? p.tag.description : `${p.source}: ${p.title ?? ""}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={p.title ?? p.source} loading="lazy" />
              </button>
            ))}
          </div>
          {photos.length === 0 ? <p className="muted">No ingested photos yet — ingest content with images first.</p> : null}
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
