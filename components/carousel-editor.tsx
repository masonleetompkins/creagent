"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  background: string | null;
};

type Region = {
  id: string;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
};

type Photo = {
  asset_id: string | null;
  title: string | null;
  source: string;
  url: string;
  tag: { description: string; tags: string; suggested: string } | null;
  regions: Region[];
};

type GenRequest = {
  id: string;
  slide_id: string | null;
  prompt: string;
  status: string;
  created_at: string;
};

const LAYOUTS = ["cover", "content", "photo", "cta"];
const BG_OPTIONS = ["", "#ffffff", "#111111", "gradient"];

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  return data;
}

async function pollJob(
  jobId: string,
  onTick?: (data: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  for (;;) {
    const data = await readJson(await fetch(`/api/jobs/${jobId}`));
    if (onTick) onTick(data);
    if (data.state === "completed" || data.state === "failed") return data;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function photoSrc(url: string): string {
  return url.startsWith("local:")
    ? `/api/photos/file?url=${encodeURIComponent(url)}`
    : url;
}

export default function CarouselEditor({ projectId }: { projectId: string }): React.ReactNode {
  const [project, setProject] = useState<Project | null>(null);
  const [slides, setSlides] = useState<Slide[]>([]);
  const [requests, setRequests] = useState<GenRequest[]>([]);
  const [sel, setSel] = useState(0);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kit, setKit] = useState({ title: "", primary: "#0b5fff", secondary: "#111111", background: "#ffffff", heading: "system-black", body: "system" });
  const [draft, setDraft] = useState({ layout: "content", heading: "", body: "", background: "" });
  const [brief, setBrief] = useState("");
  const [count, setCount] = useState("");
  const [imgPrompt, setImgPrompt] = useState("");
  const [imgTick, setImgTick] = useState(0);
  const [slideRegions, setSlideRegions] = useState<Region[]>([]);
  const [labelUrl, setLabelUrl] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState({ description: "", tags: "", suggested: "" });
  const [drawing, setDrawing] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelBoxRef = useRef<HTMLDivElement | null>(null);

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
      // The dock broadcasts without detail; a targeted event must match.
      if (!d || (d.kind === "carousel" && d.entityId === projectId)) void load();
    };
    window.addEventListener("creagent:agent-updated", onAgent);
    return () => {
      window.removeEventListener("creagent:agent-updated", onAgent);
    };
  }, [load, projectId]);

  const current = slides[sel] ?? null;
  const bgCustom = !BG_OPTIONS.includes(draft.background);
  const labelPhoto = labelUrl ? (photos.find((p) => p.url === labelUrl) ?? null) : null;
  const previewPhoto = previewUrl
    ? (photos.find((p) => p.url === previewUrl) ?? null)
    : null;

  useEffect(() => {
    if (current) {
      setDraft({ layout: current.layout, heading: current.heading, body: current.body, background: current.background ?? "" });
      setImgPrompt(current.image_prompt ?? "");
    }
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!previewUrl && !labelUrl) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closePhotoModals();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewUrl, labelUrl]);

  // Forbidden-text regions for the current slide's photo.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!current?.image_path) {
        if (!cancelled) setSlideRegions([]);
        return;
      }
      try {
        const data = await readJson(await fetch(`/api/carousels/slides/${current.id}/regions`));
        if (!cancelled) setSlideRegions(((data.regions as Region[]) ?? []));
      } catch {
        if (!cancelled) setSlideRegions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [current?.id, current?.image_path, imgTick]); // eslint-disable-line react-hooks/exhaustive-deps

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
          {
            layout: draft.layout,
            heading: draft.heading,
            body: draft.body,
            image,
            background: draft.background || null,
            regions: slideRegions,
          },
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
  }, [current?.id, current?.image_path, draft, kit, imgTick, slideRegions]); // eslint-disable-line react-hooks/exhaustive-deps

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

  async function saveSlideQuiet(): Promise<void> {
    if (!current) return;
    await readJson(
      await fetch(`/api/carousels/slides/${current.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          layout: draft.layout,
          heading: draft.heading,
          body: draft.body,
          background: draft.background || null,
        }),
      }),
    );
    await load();
  }

  async function saveSlide(): Promise<void> {
    if (!current) return;
    try {
      await saveSlideQuiet();
      setNote("Slide saved.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function runAgentJob(
    url: string,
    body: unknown,
    label: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
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
      const done = await pollJob(started.jobId as string, (d) => {
        if (!onProgress) return;
        const prog = (d.progress ?? {}) as { done?: unknown; total?: unknown };
        if (typeof prog.done === "number" && typeof prog.total === "number" && prog.total > 0) {
          onProgress(prog.done, prog.total);
        }
      });
      if (done.state === "failed") throw new Error((done.failedReason as string) ?? "job failed");
      setNote(`${label}: ${JSON.stringify(done.result ?? {}).slice(0, 300)}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runPhotoScan(): Promise<void> {
    setScanProgress({ done: 0, total: 0 });
    try {
      await runAgentJob("/api/photos/scan", { limit: 50 }, "Photo scan", (done, total) =>
        setScanProgress({ done, total }),
      );
    } finally {
      setScanProgress(null);
    }
  }

  async function decideRequest(id: string, decision: "approve" | "reject"): Promise<void> {
    setBusy(true);
    try {
      const data = await readJson(await fetch(`/api/gen-requests/${id}/${decision}`, { method: "POST" }));
      if (decision === "approve" && typeof data.jobId === "string") {
        setNote("Generating image…");
        const done = await pollJob(data.jobId);
        if (done.state === "failed") throw new Error((done.failedReason as string) ?? "image job failed");
        setImgTick((t) => t + 1);
      }
      await load();
      if (decision === "approve") setNote("Image ready.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
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
      const seeded = ((done.result ?? {}) as { seeded?: unknown }).seeded === true;
      setNote(
        seeded
          ? `Copy ready — written from your slot outline (${JSON.stringify(done.result ?? {})}).`
          : `Copy ready — fresh angle, no outline on this slot (${JSON.stringify(done.result ?? {})}).`,
      );
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

  async function usePhoto(assetId: string | null, url: string): Promise<void> {
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

  async function uploadLibrary(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      const form = new FormData();
      for (const file of Array.from(files).slice(0, 50)) form.append("file", file);
      const data = await readJson(await fetch("/api/photos/upload", { method: "POST", body: form }));
      const failures = (data.failures as { name: string; error: string }[]) ?? [];
      setNote(
        `Added ${(data.urls as string[]).length} photos to the library.` +
          (failures.length > 0 ? ` Skipped: ${failures.map((f) => `${f.name} (${f.error})`).join("; ")}` : ""),
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function openPreview(photo: Photo): void {
    setPreviewUrl(photo.url);
    setLabelUrl(null);
    setDrawing(null);
  }

  function closePhotoModals(): void {
    setPreviewUrl(null);
    setLabelUrl(null);
    setDrawing(null);
  }

  function openLabel(photo: Photo): void {
    setPreviewUrl(null);
    setLabelUrl(photo.url);
    let tags = "";
    try {
      const parsed: unknown = JSON.parse(photo.tag?.tags ?? "[]");
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string").join(", ");
    } catch { /* keep raw below */ }
    setLabelDraft({
      description: photo.tag?.description ?? "",
      tags: tags || photo.tag?.tags.replace(/["[\]]/g, "") || "",
      suggested: photo.tag?.suggested ?? "",
    });
    setDrawing(null);
  }

  async function saveLabel(): Promise<void> {
    if (!labelUrl) return;
    try {
      await readJson(
        await fetch("/api/photos", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: labelUrl,
            description: labelDraft.description,
            tags: labelDraft.tags.split(",").map((t) => t.trim()).filter(Boolean),
            suggested: labelDraft.suggested,
          }),
        }),
      );
      setNote("Label saved — matching updated.");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function labelFractions(e: React.PointerEvent): { x: number; y: number } | null {
    const box = labelBoxRef.current;
    if (!box) return null;
    const r = box.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }

  async function finishDrawing(): Promise<void> {
    const targetUrl = previewUrl ?? labelUrl;
    if (!drawing || !targetUrl) {
      setDrawing(null);
      return;
    }
    const x = Math.min(drawing.x0, drawing.x1);
    const y = Math.min(drawing.y0, drawing.y1);
    const w = Math.abs(drawing.x1 - drawing.x0);
    const h = Math.abs(drawing.y1 - drawing.y0);
    setDrawing(null);
    if (w < 0.02 || h < 0.02) return;
    try {
      await readJson(
        await fetch("/api/photos/regions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: targetUrl, x, y, w, h }),
        }),
      );
      setNote("No-text zone added — photo layouts keep copy clear of it.");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deletePhotoForever(url: string): Promise<void> {
    if (!window.confirm("Delete this photo from the library forever? It will never come back.")) {
      return;
    }
    try {
      await readJson(await fetch(`/api/photos?url=${encodeURIComponent(url)}`, { method: "DELETE" }));
      if (labelUrl === url) {
        setLabelUrl(null);
        setDrawing(null);
      }
      setNote("Photo deleted forever.");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteLabelRegion(id: string): Promise<void> {
    try {
      await readJson(await fetch(`/api/photos/regions?id=${encodeURIComponent(id)}`, { method: "DELETE" }));
      await load();
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
    if (canvasRef.current && current) download(canvasRef.current, `slide-${String(sel + 1).padStart(2, "0")}.png`);
  }

  async function renderAllSlides(): Promise<HTMLCanvasElement[]> {
    const out: HTMLCanvasElement[] = [];
    for (const s of slides) {
      const image = s.image_path
        ? await loadImage(`/api/carousels/slides/${s.id}/image?cb=${Date.now()}`).catch(() => null)
        : null;
      let regions: Region[] = [];
      if (s.image_path) {
        try {
          const data = await readJson(await fetch(`/api/carousels/slides/${s.id}/regions`));
          regions = (data.regions as Region[]) ?? [];
        } catch { /* render without regions */ }
      }
      const off = document.createElement("canvas");
      await renderSlide(
        off,
        { layout: s.layout, heading: s.heading, body: s.body, image, background: s.background, regions },
        {
          primary: kit.primary,
          secondary: kit.secondary,
          background: kit.background,
          headingFont: fontById(HEADING_FONTS, kit.heading),
          bodyFont: fontById(BODY_FONTS, kit.body),
        },
      );
      out.push(off);
    }
    return out;
  }

  async function exportAll(): Promise<void> {
    setBusy(true);
    try {
      await saveSlideQuiet();
      const rendered = await renderAllSlides();
      for (let i = 0; i < rendered.length; i++) {
        download(rendered[i], `slide-${String(i + 1).padStart(2, "0")}.png`);
        await new Promise((r) => setTimeout(r, 400));
      }
      setNote(`Exported ${rendered.length} PNGs.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("PNG encode failed"))),
        "image/png",
      );
    });
  }

  async function runAutoDesign(): Promise<void> {
    if (slides.length === 0) return;
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const data = await readJson(await fetch(`/api/carousels/${projectId}/auto-design`, { method: "POST" }));
      setNote(
        `Designed ${String(data.designed ?? 0)} slides${data.fallback ? " (offline fallback — layouts and backgrounds still applied)" : ""}.`,
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function attachAll(): Promise<boolean> {
    if (!project?.slot_id || slides.length === 0) return false;
    setBusy(true);
    try {
      await saveSlideQuiet();
      // Replace, don't append: clear prior slide images so publish never
      // ships duplicate sets.
      try {
        const prior = await readJson(await fetch(`/api/slots/${project.slot_id}/attachments`));
        const images = ((prior.attachments as { id: string; kind: string }[]) ?? []).filter(
          (a) => a.kind === "image",
        );
        for (const a of images) {
          await fetch(`/api/attachments/${a.id}`, { method: "DELETE" });
        }
      } catch {
        /* attach still proceeds; worst case is the old append behavior */
      }
      const rendered = await renderAllSlides();
      for (let i = 0; i < rendered.length; i++) {
        const blob = await canvasBlob(rendered[i]);
        const form = new FormData();
        form.append("file", blob, `slide-${String(i + 1).padStart(2, "0")}.png`);
        await readJson(
          await fetch(`/api/slots/${project.slot_id}/attachments`, { method: "POST", body: form }),
        );
      }
      setNote(`Attached ${rendered.length} PNGs to the queue slot — they ship on publish.`);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function sendBack(): Promise<void> {
    if (!project?.slot_id || slides.length === 0) return;
    if (await attachAll()) {
      window.location.href = `/queue?slot=${project.slot_id}`;
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
        {project.slot_id ? (
          <div className="row">
            <a href="/queue">← Queue</a>
            <span className="muted">Linked slot {project.slot_id.slice(0, 8)}</span>
            <button disabled={busy || slides.length === 0} onClick={() => void attachAll()}>
              Attach PNGs to slot
            </button>
            <button
              className="primary"
              disabled={busy || slides.length === 0}
              onClick={() => void sendBack()}
              title="Attach finished PNGs and return to the calendar slot for caption approval"
            >
              Approve &amp; send back
            </button>
          </div>
        ) : null}
      </section>

      <div className="toolbar">
        <button className="primary" disabled={busy} onClick={() => void runCopyJob(false)}>
          Generate copy
        </button>
        <button disabled={busy} onClick={() => void runCopyJob(true)}>Replace</button>
        <button
          disabled={busy || slides.length === 0}
          onClick={() => void runAgentJob(`/api/carousels/${projectId}/autopick`, {}, "Auto-picked")}
          title={slides.length === 0 ? "Generate copy first — there are no slides to match yet" : undefined}
        >
          Auto-pick photos
        </button>
        <button
          disabled={busy || slides.length === 0}
          onClick={() => void runAgentJob(`/api/carousels/${projectId}/plan-images`, {}, "Planned")}
          title={slides.length === 0 ? "Generate copy first — there are no slides to plan for yet" : undefined}
        >
          Plan images
        </button>
        <button disabled={busy || slides.length === 0} onClick={() => void runAutoDesign()} title="Let the model art-direct every slide's layout and background">
          Auto-design
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
          <section className="keycard" style={{ marginTop: 0 }}>
            <h2>Photo library</h2>
            <p className="muted">Upload once, analyze, reuse across every carousel.</p>
          <div className="row">
            <input
              type="file"
              accept="image/*"
              multiple
              aria-label="Upload library photos"
              disabled={busy}
              onChange={(e) => { void uploadLibrary(e.target.files); e.target.value = ""; }}
            />
          </div>
          <div className="row">
            <button disabled={busy} onClick={() => void runPhotoScan()}>
              {scanProgress ? "Analyzing…" : "Analyze photos"}
            </button>
            {scanProgress ? <span className="spin" aria-hidden="true" /> : null}
            <span className="muted">
              {scanProgress && scanProgress.total > 0
                ? `${scanProgress.done}/${scanProgress.total}`
                : `${photos.filter((p) => p.tag?.description).length}/${photos.length} analyzed`}
            </span>
          </div>
          <div className="photogrid">
            {photos.map((p) => (
              <div key={`${p.asset_id ?? "upl"}-${p.url}`} className={`photo${p.tag?.description ? " tagged" : ""}`}>
                <button
                  onClick={() => openPreview(p)}
                  title="Open large preview — mark no-text zones, attach to slide"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photoSrc(p.url)} alt={p.title ?? p.source} loading="lazy" />
                </button>
                <button
                  className="tagbtn"
                  aria-label="Edit label and no-text zones"
                  title={p.tag?.description || "Label this photo"}
                  onClick={() => openLabel(p)}
                >
                  🏷{p.regions.length > 0 ? ` ${p.regions.length}` : ""}
                </button>
                <button
                  className="delbtn"
                  aria-label="Delete photo forever"
                  title="Delete forever — it will never come back"
                  onClick={() => void deletePhotoForever(p.url)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          {photos.length === 0 ? <p className="muted">No photos yet — upload some above to build your library.</p> : null}
          {previewPhoto ? createPortal(
            <div className="modal-backdrop" onClick={() => closePhotoModals()}>
              <div className="modal wide" role="dialog" aria-label="Photo preview" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                  <h2>Preview</h2>
                  <button onClick={() => closePhotoModals()}>Close</button>
                </div>
                <p className="muted">
                  {previewPhoto.source}
                  {previewPhoto.tag?.description ? "" : " — not analyzed yet"}
                  {" · "}Drag on the photo to mark a no-text zone — the model keeps copy clear of it.
                </p>
                <div
                  ref={labelBoxRef}
                  className="labelbox"
                  onPointerDown={(e) => {
                    const f = labelFractions(e);
                    if (f) {
                      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                      setDrawing({ x0: f.x, y0: f.y, x1: f.x, y1: f.y });
                    }
                  }}
                  onPointerMove={(e) => {
                    if (!drawing) return;
                    const f = labelFractions(e);
                    if (f) setDrawing({ ...drawing, x1: f.x, y1: f.y });
                  }}
                  onPointerUp={() => void finishDrawing()}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photoSrc(previewPhoto.url)} alt="" />
                  {previewPhoto.regions.map((r) => (
                    <span
                      key={r.id}
                      className="region"
                      style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
                      title={r.label || "No-text zone"}
                    />
                  ))}
                  {drawing ? (
                    <span
                      className="region drawing"
                      style={{
                        left: `${Math.min(drawing.x0, drawing.x1) * 100}%`,
                        top: `${Math.min(drawing.y0, drawing.y1) * 100}%`,
                        width: `${Math.abs(drawing.x1 - drawing.x0) * 100}%`,
                        height: `${Math.abs(drawing.y1 - drawing.y0) * 100}%`,
                      }}
                    />
                  ) : null}
                </div>
                {previewPhoto.regions.length > 0 ? (
                  <div className="row">
                    {previewPhoto.regions.map((r, i) => (
                      <button key={r.id} onClick={() => void deleteLabelRegion(r.id)} title="Delete zone">
                        Zone {i + 1} ✕
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="row">
                  <button
                    className="primary"
                    disabled={!current}
                    title={current ? "Attach to the current slide" : "Add a slide first"}
                    onClick={() => {
                      if (!previewPhoto) return;
                      const url = previewPhoto.url;
                      const assetId = previewPhoto.asset_id;
                      closePhotoModals();
                      void usePhoto(assetId, url);
                    }}
                  >
                    Attach to slide
                  </button>
                  <button className="danger" onClick={() => void deletePhotoForever(previewPhoto.url)}>
                    Delete forever
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          ) : null}
          {labelPhoto ? createPortal(
            <div className="modal-backdrop" onClick={() => closePhotoModals()}>
              <div className="modal" role="dialog" aria-label="Photo analysis" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                  <h2>Analysis</h2>
                  <button onClick={() => closePhotoModals()}>Close</button>
                </div>
                <p className="muted">
                  {labelPhoto.source}
                  {labelPhoto.tag?.description ? "" : " — not analyzed yet"}
                  {labelPhoto.regions.length > 0 ? ` · ${labelPhoto.regions.length} no-text zone${labelPhoto.regions.length === 1 ? "" : "s"}` : ""}
                </p>
                <div className="row">
                  <textarea
                    aria-label="Description"
                    rows={3}
                    placeholder="What is in this photo?"
                    value={labelDraft.description}
                    onChange={(e) => setLabelDraft({ ...labelDraft, description: e.target.value })}
                  />
                </div>
                <div className="row">
                  <input
                    type="text"
                    aria-label="Tags"
                    placeholder="tags, comma separated"
                    value={labelDraft.tags}
                    onChange={(e) => setLabelDraft({ ...labelDraft, tags: e.target.value })}
                  />
                </div>
                <div className="row">
                  <input
                    type="text"
                    aria-label="Suggested use"
                    placeholder="Suggested use"
                    value={labelDraft.suggested}
                    onChange={(e) => setLabelDraft({ ...labelDraft, suggested: e.target.value })}
                  />
                  <button className="primary" onClick={() => void saveLabel()}>Save label</button>
                </div>
              </div>
            </div>,
            document.body,
          ) : null}

            </section>
        </div>
        <div>
            <section className="keycard" style={{ marginTop: 0 }}>
            <div className="ced-combined">
            <div className="ced-combined-slides">
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
            <div className="ced-combined-canvas">
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
                <select
                  aria-label="Background"
                  value={bgCustom ? "custom" : draft.background}
                  onChange={(e) => {
                    if (e.target.value !== "custom") setDraft({ ...draft, background: e.target.value });
                  }}
                >
                  <option value="">Bg: kit</option>
                  <option value="#ffffff">Bg: white</option>
                  <option value="#111111">Bg: black</option>
                  <option value="gradient">Bg: gradient</option>
                  {bgCustom ? <option value="custom">Bg: custom</option> : null}
                </select>
                <input
                  type="color"
                  aria-label="Custom background"
                  title="Custom background color"
                  value={/^#[0-9a-fA-F]{6}$/.test(draft.background) ? draft.background : "#ffffff"}
                  onChange={(e) => setDraft({ ...draft, background: e.target.value })}
                />
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
            </div>
            </div>
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
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
