"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BODY_FONTS, HEADING_FONTS, fontById } from "@/lib/fonts";

type Clip = {
  id: string;
  track_id: string;
  asset_id: string | null;
  name: string;
  start_ms: number;
  duration_ms: number;
  in_ms: number;
  speed: number;
  payload: string;
  asset: { filename: string; kind: string; duration_ms: number | null } | null;
};

type Track = {
  id: string;
  kind: "video" | "audio" | "caption" | "graphics" | "review";
  name: string;
  position: number;
  muted: number;
  hidden: number;
};

type Detail = {
  project: {
    id: string;
    title: string;
    width: number;
    height: number;
    fps: number;
    style: string;
  };
  tracks: (Track & { clips: Clip[] })[];
  captions: {
    id: string;
    start_ms: number;
    end_ms: number;
    lines: { text: string; start_ms: number; end_ms: number }[];
    enabled: number;
  }[];
  notes: { id: string; start_ms: number; end_ms: number; body: string; status: string }[];
};

type Asset = {
  id: string;
  kind: string;
  filename: string;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
};

type Word = { word: string; start_ms: number; end_ms: number; conf: number | null };

type Take = {
  id: string;
  label: string;
  start_ms: number;
  end_ms: number;
  text: string;
  score: number | null;
  verdict: "keep" | "cut" | "unsure";
};

type AudioEntry = {
  id: string;
  kind: string;
  title: string;
  source: string;
  url: string | null;
  local_path: string | null;
  duration_ms: number | null;
  license: string | null;
};

type CommonsResult = {
  title: string;
  url: string;
  size: number | null;
  duration_ms: number | null;
  license: string | null;
  license_url: string | null;
  artist: string | null;
  description: string | null;
};

const ZONES: Record<string, { label: string; top: number; bottom: number; left: number; right: number }> = {
  reels: { label: "IG Reels", top: 0.08, bottom: 0.25, left: 0.04, right: 0.12 },
  tiktok: { label: "TikTok", top: 0.12, bottom: 0.22, left: 0.04, right: 0.13 },
  shorts: { label: "YT Shorts", top: 0.08, bottom: 0.15, left: 0.04, right: 0.11 },
  facebook: { label: "FB Reels", top: 0.09, bottom: 0.24, left: 0.04, right: 0.11 },
};

function fmt(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(2).padStart(5, "0")}`;
}

function tickStep(pxPerSec: number): number {
  for (const s of [0.25, 0.5, 1, 2, 5, 10, 30, 60]) {
    if (s * pxPerSec >= 70) return s;
  }
  return 120;
}

export default function VideoEditor({ projectId }: { projectId: string }): React.ReactNode {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [media, setMedia] = useState<Asset[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pxPerSec, setPxPerSec] = useState(70);
  const [zone, setZone] = useState("reels");
  const [tab, setTab] = useState<
    "media" | "transcript" | "raw" | "captions" | "audio" | "graphics"
  >("media");
  const [reviewMode, setReviewMode] = useState(false);
  const [error, setError] = useState("");
  const [transcriptAsset, setTranscriptAsset] = useState("");
  const [words, setWords] = useState<Word[]>([]);
  const [takes, setTakes] = useState<Take[]>([]);
  const [rawAsset, setRawAsset] = useState("");
  const [rawTakes, setRawTakes] = useState<Take[]>([]);
  const [ranges, setRanges] = useState<{ start_ms: number; end_ms: number }[]>([]);
  const [rawPreview, setRawPreview] = useState<{ assetId: string; atMs: number } | null>(null);
  const [noteRange, setNoteRange] = useState<{ start: number; end: number } | null>(null);
  const [noteBody, setNoteBody] = useState("");
  const [registerPath, setRegisterPath] = useState("");
  const [over, setOver] = useState<Record<string, { start_ms: number; duration_ms: number; in_ms: number }>>({});
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const dragRef = useRef<{
    clipId: string;
    mode: "move" | "trim-l" | "trim-r";
    startX: number;
    orig: { start_ms: number; duration_ms: number; in_ms: number };
  } | null>(null);
  const playRef = useRef<{ raf: number; last: number } | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/video-projects/${projectId}`);
    if (!res.ok) {
      setError(`project load failed: ${res.status}`);
      return;
    }
    setDetail((await res.json()) as Detail);
  }, [projectId]);

  const refreshMedia = useCallback(async () => {
    const res = await fetch("/api/media");
    if (res.ok) setMedia(((await res.json()) as { media: Asset[] }).media);
  }, []);

  useEffect(() => {
    void refresh();
    void refreshMedia();
  }, [refresh, refreshMedia]);

  useEffect(() => {
    const onAgent = (e: Event): void => {
      const d = (e as CustomEvent<{ kind?: string; entityId?: string }>).detail;
      if (d?.kind === "video" && d.entityId === projectId) {
        void refresh();
        void refreshMedia();
      }
    };
    window.addEventListener("creagent:agent-updated", onAgent);
    return () => {
      window.removeEventListener("creagent:agent-updated", onAgent);
    };
  }, [refresh, refreshMedia, projectId]);

  const duration = useMemo(() => {
    if (!detail) return 0;
    let end = 0;
    for (const t of detail.tracks) {
      for (const c of t.clips) end = Math.max(end, c.start_ms + c.duration_ms);
    }
    return end;
  }, [detail]);

  const clipAt = useCallback(
    (ms: number, kind: "video" | "audio"): Clip | null => {
      if (!detail) return null;
      for (const t of detail.tracks) {
        if (t.kind !== kind || (kind === "video" && t.hidden) || (kind === "audio" && t.muted)) continue;
        const hit = t.clips.find((c) => ms >= c.start_ms && ms < c.start_ms + c.duration_ms);
        if (hit) return hit;
      }
      return null;
    },
    [detail],
  );

  // Preview sync: timeline playhead -> source frame under the topmost clip.
  const previewClip = rawPreview ? null : clipAt(playhead, "video");
  const previewAudio = rawPreview ? null : clipAt(playhead, "audio");
  const rawAssetObj = rawPreview ? media.find((m) => m.id === rawPreview.assetId) ?? null : null;

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (rawPreview) {
      const want = `/api/media/${rawPreview.assetId}/file`;
      if (el.getAttribute("src") !== want) {
        el.src = want;
        el.currentTime = rawPreview.atMs / 1000;
      } else if (Math.abs(el.currentTime * 1000 - rawPreview.atMs) > 250 && !playing) {
        el.currentTime = rawPreview.atMs / 1000;
      }
      return;
    }
    if (!previewClip?.asset_id) {
      el.removeAttribute("src");
      el.load();
      return;
    }
    const want = `/api/media/${previewClip.asset_id}/file`;
    const at = (previewClip.in_ms + (playhead - previewClip.start_ms)) / 1000;
    if (el.getAttribute("src") !== want) {
      el.src = want;
      el.currentTime = Math.max(0, at);
    } else if (Math.abs(el.currentTime - at) > 0.25) {
      el.currentTime = Math.max(0, at);
    }
    if (playing) void el.play().catch(() => undefined);
    else el.pause();
  }, [previewClip, playhead, playing, rawPreview]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || rawPreview) return;
    if (!previewAudio?.asset_id) {
      el.pause();
      return;
    }
    const want = `/api/media/${previewAudio.asset_id}/file`;
    const at = (previewAudio.in_ms + (playhead - previewAudio.start_ms)) / 1000;
    if (el.getAttribute("src") !== want) {
      el.src = want;
      el.currentTime = Math.max(0, at);
    } else if (Math.abs(el.currentTime - at) > 0.3) {
      el.currentTime = Math.max(0, at);
    }
    if (playing) void el.play().catch(() => undefined);
    else el.pause();
  }, [previewAudio, playhead, playing, rawPreview]);

  useEffect(() => {
    if (!playing) {
      if (playRef.current) cancelAnimationFrame(playRef.current.raf);
      playRef.current = null;
      return;
    }
    // Raw-mode playback advances the raw preview clock instead.
    if (rawPreview) {
      const el = videoRef.current;
      if (el) void el.play().catch(() => undefined);
      const tick = (): void => {
        if (videoRef.current) {
          setRawPreview((r) => (r ? { ...r, atMs: videoRef.current!.currentTime * 1000 } : r));
        }
        playRef.current = { raf: requestAnimationFrame(tick), last: 0 };
      };
      playRef.current = { raf: requestAnimationFrame(tick), last: 0 };
      return () => {
        if (playRef.current) cancelAnimationFrame(playRef.current.raf);
      };
    }
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = now - last;
      last = now;
      setPlayhead((p) => {
        const next = p + dt;
        if (next >= duration && duration > 0) {
          setPlaying(false);
          return duration;
        }
        return next;
      });
      playRef.current = { raf: requestAnimationFrame(tick), last };
    };
    playRef.current = { raf: requestAnimationFrame(tick), last };
    return () => {
      if (playRef.current) cancelAnimationFrame(playRef.current.raf);
    };
  }, [playing, duration, rawPreview]);

  const activeCaption = useMemo(() => {
    if (!detail || rawPreview) return null;
    return (
      detail.captions.find((c) => c.enabled && playhead >= c.start_ms && playhead < c.end_ms) ?? null
    );
  }, [detail, playhead, rawPreview]);

  const styleState = useMemo(() => {
    try {
      const s = JSON.parse(detail?.project.style ?? "{}") as {
        caption_font?: unknown;
        heading_font?: unknown;
      };
      return {
        caption_font: typeof s.caption_font === "string" ? s.caption_font : "system",
        heading_font: typeof s.heading_font === "string" ? s.heading_font : "system-black",
      };
    } catch {
      return { caption_font: "system", heading_font: "system-black" };
    }
  }, [detail]);

  const captionFont = useMemo(
    () => fontById(BODY_FONTS, styleState.caption_font),
    [styleState.caption_font],
  );
  const headingFont = useMemo(
    () => fontById(HEADING_FONTS, styleState.heading_font),
    [styleState.heading_font],
  );

  const activeGraphics = useMemo(() => {
    if (!detail || rawPreview) return [];
    const out: { id: string; text: string; y_pct: number; fontsize: number; color: string }[] = [];
    for (const t of detail.tracks) {
      if (t.kind !== "graphics") continue;
      for (const c of t.clips) {
        if (playhead < c.start_ms || playhead >= c.start_ms + c.duration_ms) continue;
        try {
          const p = JSON.parse(c.payload) as {
            text?: unknown;
            y_pct?: unknown;
            fontsize?: unknown;
            color?: unknown;
          };
          if (typeof p.text === "string" && p.text.trim()) {
            out.push({
              id: c.id,
              text: p.text,
              y_pct: typeof p.y_pct === "number" ? p.y_pct : 12,
              fontsize: typeof p.fontsize === "number" ? p.fontsize : 72,
              color: typeof p.color === "string" ? p.color : "white",
            });
          }
        } catch {
          /* not a text card */
        }
      }
    }
    return out;
  }, [detail, playhead, rawPreview]);

  const activeHf = useMemo(() => {
    if (!detail || rawPreview) return [];
    const out: { id: string }[] = [];
    for (const t of detail.tracks) {
      if (t.kind !== "graphics") continue;
      for (const c of t.clips) {
        if (playhead < c.start_ms || playhead >= c.start_ms + c.duration_ms) continue;
        try {
          const p = JSON.parse(c.payload) as { kind?: unknown };
          if (p.kind === "hyperframes") out.push({ id: c.id });
        } catch {
          /* plain clip */
        }
      }
    }
    return out;
  }, [detail, playhead, rawPreview]);

  const saveStyle = useCallback(
    async (edit: { caption_font?: string; heading_font?: string }) => {
      await fetch(`/api/video-projects/${projectId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(edit),
      });
      await refresh();
    },
    [projectId, refresh],
  );

  const loadTranscript = useCallback(
    async (assetId: string) => {
      setTranscriptAsset(assetId);
      setWords([]);
      setTakes([]);
      if (!assetId) return;
      const res = await fetch(`/api/media/${assetId}/transcript`);
      if (res.ok) {
        const data = (await res.json()) as { words: Word[] };
        setWords(data.words);
      }
      const takesRes = await fetch(`/api/video-projects/${projectId}/autocut?assetId=${assetId}`);
      if (takesRes.ok) {
        const data = (await takesRes.json()) as { takes: Take[] };
        setTakes(data.takes);
      }
    },
    [projectId],
  );

  const loadRaw = useCallback(
    async (assetId: string) => {
      setRawAsset(assetId);
      setRanges([]);
      setRawTakes([]);
      if (!assetId) return;
      const r = await fetch(`/api/video-projects/${projectId}/used-ranges?assetId=${assetId}`);
      if (r.ok) setRanges(((await r.json()) as { ranges: { start_ms: number; end_ms: number }[] }).ranges);
      const t = await fetch(`/api/video-projects/${projectId}/autocut?assetId=${assetId}`);
      if (t.ok) setRawTakes(((await t.json()) as { takes: Take[] }).takes);
    },
    [projectId],
  );

  const jumpToWord = useCallback(
    (w: Word) => {
      if (!detail || !transcriptAsset) return;
      for (const t of detail.tracks) {
        if (t.kind !== "video" && t.kind !== "audio") continue;
        const hit = t.clips.find(
          (c) =>
            c.asset_id === transcriptAsset &&
            w.start_ms >= c.in_ms &&
            w.start_ms < c.in_ms + c.duration_ms,
        );
        if (hit) {
          setRawPreview(null);
          setPlayhead(hit.start_ms + (w.start_ms - hit.in_ms));
          return;
        }
      }
      setRawPreview({ assetId: transcriptAsset, atMs: w.start_ms });
    },
    [detail, transcriptAsset],
  );

  const runAutocut = useCallback(async () => {
    if (!transcriptAsset) return;
    setError("");
    const res = await fetch(`/api/video-projects/${projectId}/autocut`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetId: transcriptAsset }),
    });
    if (!res.ok) {
      setError(`auto-cut failed: ${(await res.json()).error ?? res.status}`);
      return;
    }
    const data = (await res.json()) as { takes: Take[] };
    setTakes(data.takes);
    if (rawAsset === transcriptAsset) setRawTakes(data.takes);
  }, [projectId, transcriptAsset, rawAsset]);

  const applyTakes = useCallback(async () => {
    if (!detail || !transcriptAsset) return;
    const v1 = detail.tracks.find((t) => t.kind === "video");
    if (!v1) {
      setError("no video track to apply takes to");
      return;
    }
    const res = await fetch(`/api/video-projects/${projectId}/autocut`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trackId: v1.id, assetId: transcriptAsset }),
    });
    if (!res.ok) {
      setError(`apply failed: ${(await res.json()).error ?? res.status}`);
      return;
    }
    setTab("media");
    await refresh();
  }, [detail, projectId, transcriptAsset, refresh]);

  const addTakeToTimeline = useCallback(
    async (take: Take) => {
      if (!detail || !rawAsset) return;
      const v1 = detail.tracks.find((t) => t.kind === "video");
      if (!v1) return;
      await fetch(`/api/video-projects/${projectId}/clips`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trackId: v1.id,
          assetId: rawAsset,
          name: take.label,
          inMs: take.start_ms,
          durationMs: take.end_ms - take.start_ms,
        }),
      });
      await refresh();
      await loadRaw(rawAsset);
    },
    [detail, projectId, rawAsset, refresh, loadRaw],
  );
  // ---- timeline drag: move bodies, ripple-trim edges ----
  const contentRef = useRef<HTMLDivElement | null>(null);

  const xToMs = useCallback(
    (clientX: number): number => {
      const rect = contentRef.current?.getBoundingClientRect();
      if (!rect) return 0;
      return Math.max(0, ((clientX - rect.left) / pxPerSec) * 1000);
    },
    [pxPerSec],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      const dMs = ((e.clientX - drag.startX) / pxPerSec) * 1000;
      if (drag.mode === "move") {
        const start = Math.max(0, Math.round(drag.orig.start_ms + dMs));
        setOver((o) => ({ ...o, [drag.clipId]: { ...drag.orig, start_ms: start } }));
      } else if (drag.mode === "trim-r") {
        const duration = Math.max(40, Math.round(drag.orig.duration_ms + dMs));
        setOver((o) => ({ ...o, [drag.clipId]: { ...drag.orig, duration_ms: duration } }));
      } else {
        const nextIn = Math.max(0, Math.round(drag.orig.in_ms + dMs));
        const applied = nextIn - drag.orig.in_ms;
        const duration = Math.max(40, drag.orig.duration_ms - applied);
        const start = Math.max(0, drag.orig.start_ms + applied);
        setOver((o) => ({
          ...o,
          [drag.clipId]: { start_ms: start, duration_ms: duration, in_ms: nextIn },
        }));
      }
    };
    const onUp = async (): Promise<void> => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      let current: { start_ms: number; duration_ms: number; in_ms: number } | null = null;
      setOver((o) => {
        current = o[drag.clipId] ?? null;
        const next = { ...o };
        delete next[drag.clipId];
        return next;
      });
      await new Promise((r) => setTimeout(r, 0));
      const c = current as unknown as {
        start_ms: number;
        duration_ms: number;
        in_ms: number;
      } | null;
      if (!c) return;
      if (drag.mode === "move") {
        if (c.start_ms !== drag.orig.start_ms) {
          await fetch(`/api/video-projects/clips/${drag.clipId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ startMs: c.start_ms }),
          });
        }
      } else if (c.in_ms !== drag.orig.in_ms || c.duration_ms !== drag.orig.duration_ms) {
        await fetch(`/api/video-projects/clips/${drag.clipId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ inMs: c.in_ms, durationMs: c.duration_ms, ripple: true }),
        });
      }
      await refresh();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [pxPerSec, refresh]);

  const beginDrag = useCallback(
    (e: React.PointerEvent, clip: Clip, mode: "move" | "trim-l" | "trim-r") => {
      e.stopPropagation();
      setSelected(clip.id);
      dragRef.current = {
        clipId: clip.id,
        mode,
        startX: e.clientX,
        orig: { start_ms: clip.start_ms, duration_ms: clip.duration_ms, in_ms: clip.in_ms },
      };
    },
    [],
  );

  const splitAtPlayhead = useCallback(async () => {
    if (!detail) return;
    const v1 = detail.tracks.find((t) => t.kind === "video");
    if (!v1) return;
    const hit = v1.clips.find(
      (c) => playhead > c.start_ms && playhead < c.start_ms + c.duration_ms,
    );
    if (!hit) return;
    await fetch(`/api/video-projects/clips/${hit.id}/split`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ atMs: Math.round(playhead) }),
    });
    await refresh();
  }, [detail, playhead, refresh]);

  const deleteSelected = useCallback(async () => {
    if (!selected) return;
    await fetch(`/api/video-projects/clips/${selected}?ripple=1`, { method: "DELETE" });
    setSelected(null);
    await refresh();
  }, [selected, refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "s" || e.key === "S") {
        void splitAtPlayhead();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected) {
        void deleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [splitAtPlayhead, deleteSelected, selected]);

  // ---- review notes ----
  const reviewDrag = useRef<{ from: number } | null>(null);

  const saveNote = useCallback(async () => {
    if (!noteRange || !noteBody.trim()) return;
    await fetch(`/api/video-projects/${projectId}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startMs: Math.round(Math.min(noteRange.start, noteRange.end)),
        endMs: Math.round(Math.max(noteRange.start, noteRange.end)),
        body: noteBody.trim(),
      }),
    });
    setNoteRange(null);
    setNoteBody("");
    await refresh();
  }, [noteRange, noteBody, projectId, refresh]);

  // ---- media bin ----
  const uploadFile = useCallback(
    async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      setError("");
      const res = await fetch("/api/media/upload", { method: "POST", body: form });
      if (!res.ok) setError(`upload failed: ${res.status}`);
      await refreshMedia();
    },
    [refreshMedia],
  );

  const registerFile = useCallback(async () => {
    if (!registerPath.trim()) return;
    setError("");
    const res = await fetch("/api/media/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: registerPath.trim() }),
    });
    if (!res.ok) setError(`register failed: ${(await res.json()).error ?? res.status}`);
    else setRegisterPath("");
    await refreshMedia();
  }, [registerPath, refreshMedia]);

  const transcribeAsset = useCallback(
    async (assetId: string) => {
      setError("");
      const res = await fetch(`/api/media/${assetId}/transcribe`, { method: "POST" });
      if (!res.ok) {
        setError(`transcribe failed: ${res.status}`);
        return;
      }
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const t = await fetch(`/api/media/${assetId}/transcript`);
        if (t.ok) {
          await refreshMedia();
          const data = (await t.json()) as { words: Word[] };
          setWords(data.words);
          setTranscriptAsset(assetId);
          return;
        }
      }
      setError("transcription still running; reopen the transcript tab shortly.");
    },
    [refreshMedia],
  );

  const addAssetToTrack = useCallback(
    async (asset: Asset, kind: "video" | "audio") => {
      if (!detail) return;
      const track = detail.tracks.find((t) => t.kind === kind);
      if (!track) {
        setError(`no ${kind} track`);
        return;
      }
      const fallback =
        asset.duration_ms ??
        (transcriptAsset === asset.id && words.length > 0
          ? words[words.length - 1].end_ms
          : 10000);
      await fetch(`/api/video-projects/${projectId}/clips`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trackId: track.id,
          assetId: asset.id,
          name: asset.filename,
          inMs: 0,
          durationMs: fallback,
        }),
      });
      await refresh();
    },
    [detail, projectId, refresh, transcriptAsset, words],
  );

  // ---- captions ----
  const [capAsset, setCapAsset] = useState("");
  const [capWpl, setCapWpl] = useState(4);
  const [capMaxLines, setCapMaxLines] = useState(2);
  const [selWord, setSelWord] = useState<{ block: string; line: number; word: number } | null>(null);

  const capAction = useCallback(
    async (capId: string, action: string, extra?: Record<string, unknown>) => {
      await fetch(`/api/video-projects/captions/${capId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, projectId, ...extra }),
      });
      setSelWord(null);
      await refresh();
    },
    [projectId, refresh],
  );

  const patchCaption = useCallback(
    async (capId: string, edit: Record<string, unknown>) => {
      await fetch(`/api/video-projects/captions/${capId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(edit),
      });
      await refresh();
    },
    [refresh],
  );

  const generateCaptions = useCallback(
    async (replace: boolean) => {
      if (!capAsset) return;
      setError("");
      const res = await fetch(`/api/video-projects/${projectId}/captions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assetId: capAsset,
          wordsPerLine: capWpl,
          maxLines: capMaxLines,
          replace,
        }),
      });
      if (!res.ok) setError(`caption generate failed: ${(await res.json()).error ?? res.status}`);
      await refresh();
    },
    [capAsset, capWpl, capMaxLines, projectId, refresh],
  );

  const insertBroll = useCallback(
    async (asset: Asset) => {
      if (!detail) return;
      const main = detail.tracks.find((t) => t.kind === "video" && t.name === "Main")
        ?? detail.tracks.find((t) => t.kind === "video");
      if (!main) {
        setError("no video track for B-roll");
        return;
      }
      await fetch(`/api/video-projects/${projectId}/clips`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trackId: main.id,
          assetId: asset.id,
          name: `B-roll ${asset.filename}`,
          inMs: 0,
          durationMs: asset.duration_ms ?? 5000,
          atMs: Math.round(playhead),
        }),
      });
      await refresh();
    },
    [detail, projectId, playhead, refresh],
  );

  // ---- SFX / music library ----
  const [audioKind, setAudioKind] = useState<"sfx" | "music">("sfx");
  const [library, setLibrary] = useState<AudioEntry[]>([]);
  const [audioQuery, setAudioQuery] = useState("");
  const [commons, setCommons] = useState<CommonsResult[]>([]);
  const [audioSearching, setAudioSearching] = useState(false);
  const [audioPath, setAudioPath] = useState("");

  const loadLibrary = useCallback(async (kind: "sfx" | "music") => {
    const res = await fetch(`/api/audio?kind=${kind}`);
    if (res.ok) setLibrary(((await res.json()) as { audio: AudioEntry[] }).audio);
  }, []);

  useEffect(() => {
    if (tab === "audio") void loadLibrary(audioKind);
  }, [tab, audioKind, loadLibrary]);

  const runCommonsSearch = useCallback(async () => {
    if (!audioQuery.trim()) return;
    setAudioSearching(true);
    setError("");
    try {
      const res = await fetch("/api/audio/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: audioQuery.trim(), limit: 10 }),
      });
      if (!res.ok) {
        setError(`search failed: ${(await res.json()).error ?? res.status}`);
        return;
      }
      setCommons(((await res.json()) as { results: CommonsResult[] }).results);
    } finally {
      setAudioSearching(false);
    }
  }, [audioQuery]);

  const fetchCommonsResult = useCallback(
    async (result: CommonsResult) => {
      setError("");
      const res = await fetch("/api/audio/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: audioKind, ...result }),
      });
      if (!res.ok) setError(`fetch failed: ${(await res.json()).error ?? res.status}`);
      await loadLibrary(audioKind);
    },
    [audioKind, loadLibrary],
  );

  const addLocalAudio = useCallback(async () => {
    if (!audioPath.trim()) return;
    setError("");
    const res = await fetch("/api/audio", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: audioKind, path: audioPath.trim() }),
    });
    if (!res.ok) setError(`add failed: ${(await res.json()).error ?? res.status}`);
    else setAudioPath("");
    await loadLibrary(audioKind);
  }, [audioPath, audioKind, loadLibrary]);

  const uploadAudio = useCallback(
    async (file: File) => {
      setError("");
      const form = new FormData();
      form.append("file", file);
      const up = await fetch("/api/media/upload", { method: "POST", body: form });
      if (!up.ok) {
        setError(`upload failed: ${up.status}`);
        return;
      }
      const asset = ((await up.json()) as { asset: { path: string } }).asset;
      await fetch("/api/audio", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: audioKind, path: asset.path, title: file.name }),
      });
      await loadLibrary(audioKind);
    },
    [audioKind, loadLibrary],
  );

  const entryToTimeline = useCallback(
    async (entryId: string, atPlayhead: boolean) => {
      setError("");
      const res = await fetch(`/api/audio/${entryId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          ...(atPlayhead ? { atMs: Math.round(playhead) } : {}),
        }),
      });
      if (!res.ok) setError(`add failed: ${(await res.json()).error ?? res.status}`);
      await refresh();
    },
    [projectId, playhead, refresh],
  );

  // ---- graphics text cards ----
  const [gfxText, setGfxText] = useState("");
  const [gfxDur, setGfxDur] = useState(3000);
  const [gfxY, setGfxY] = useState(12);
  const [gfxSize, setGfxSize] = useState(72);
  const [hfHtml, setHfHtml] = useState("");
  const [hfBusy, setHfBusy] = useState(false);
  const [posters, setPosters] = useState<Record<string, string>>({});

  const graphicsTrackId = useCallback(async (): Promise<string | null> => {
    if (!detail) return null;
    const existing = detail.tracks.find((t) => t.kind === "graphics");
    if (existing) return existing.id;
    const res = await fetch(`/api/video-projects/${projectId}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "graphics", name: "Graphics" }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { track: { id: string } };
    return data.track.id;
  }, [detail, projectId]);

  const addGraphic = useCallback(async () => {
    if (!gfxText.trim()) return;
    const trackId = await graphicsTrackId();
    if (!trackId) {
      setError("no graphics track");
      return;
    }
    await fetch(`/api/video-projects/${projectId}/clips`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId,
        name: gfxText.trim().slice(0, 40),
        durationMs: gfxDur,
        atMs: Math.round(playhead),
        payload: { text: gfxText.trim(), y_pct: gfxY, fontsize: gfxSize, color: "white", box: true },
      }),
    });
    setGfxText("");
    await refresh();
  }, [gfxText, gfxDur, gfxY, gfxSize, playhead, projectId, refresh, graphicsTrackId]);

  const saveGraphic = useCallback(
    async (
      clip: Clip,
      edit: { text?: string; y_pct?: number; fontsize?: number; kind?: string; html?: string },
    ) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(clip.payload) as Record<string, unknown>;
      } catch {
        /* reset */
      }
      await fetch(`/api/video-projects/clips/${clip.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { ...payload, ...edit } }),
      });
      await refresh();
    },
    [refresh],
  );

  const addHyperframes = useCallback(async () => {
    if (!hfHtml.trim()) return;
    const trackId = await graphicsTrackId();
    if (!trackId) {
      setError("no graphics track");
      return;
    }
    await fetch(`/api/video-projects/${projectId}/clips`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        trackId,
        name: "Hyperframes overlay",
        durationMs: gfxDur,
        atMs: Math.round(playhead),
        payload: { kind: "hyperframes", html: hfHtml },
      }),
    });
    setHfHtml("");
    await refresh();
  }, [hfHtml, gfxDur, playhead, projectId, refresh, graphicsTrackId]);

  const renderHfPreview = useCallback(
    async (clipId: string) => {
      setHfBusy(true);
      setError("");
      try {
        const res = await fetch(`/api/video-projects/${projectId}/hyperframes/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clipId }),
        });
        if (!res.ok) {
          setError(`preview failed: ${(await res.json()).error ?? res.status}`);
          return;
        }
        const { hash } = (await res.json()) as { hash: string };
        setPosters((p) => ({ ...p, [clipId]: hash }));
      } finally {
        setHfBusy(false);
      }
    },
    [projectId],
  );

  // ---- export ----
  const [burnCaps, setBurnCaps] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exports, setExports] = useState<
    { id: string; path: string; width: number; height: number; created_at: string }[]
  >([]);

  const loadExports = useCallback(async () => {
    const res = await fetch(`/api/video-projects/${projectId}/export`);
    if (res.ok) {
      setExports(
        (
          (await res.json()) as {
            exports: { id: string; path: string; width: number; height: number; created_at: string }[];
          }
        ).exports,
      );
    }
  }, [projectId]);

  useEffect(() => {
    void loadExports();
  }, [loadExports]);

  const runExport = useCallback(async () => {
    setExporting(true);
    setError("");
    try {
      const res = await fetch(`/api/video-projects/${projectId}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ burnCaptions: burnCaps }),
      });
      if (!res.ok) {
        setError(`export failed to start: ${res.status}`);
        return;
      }
      const { jobId } = (await res.json()) as { jobId: string };
      for (let i = 0; i < 360; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const poll = await fetch(`/api/jobs/${jobId}`);
        if (!poll.ok) break;
        const job = (await poll.json()) as { state: string; failedReason?: string };
        if (job.state === "completed") {
          await loadExports();
          return;
        }
        if (job.state === "failed") {
          setError(`export failed: ${job.failedReason ?? "unknown"}`);
          return;
        }
      }
      setError("export is still rendering — it will appear below when done.");
      await loadExports();
    } finally {
      setExporting(false);
    }
  }, [projectId, burnCaps, loadExports]);

  // ---- CorridorKey subject keying + Luma hint painter ----
  const [keyClip, setKeyClip] = useState<Clip | null>(null);
  const [keySidecar, setKeySidecar] = useState<{
    configured: boolean;
    reachable: boolean;
    managed: boolean;
    setup: string;
    error?: string;
    url: string | null;
  } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [paintColor, setPaintColor] = useState<"white" | "black">("white");
  const [brush, setBrush] = useState(24);
  const [keyJob, setKeyJob] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const painting = useRef(false);

  const openKeyModal = useCallback(async () => {
    if (!detail || !selected) return;
    const clip = detail.tracks.flatMap((t) => t.clips).find((c) => c.id === selected) ?? null;
    if (!clip?.asset_id) {
      setError("select a clip with source footage first");
      return;
    }
    setKeyClip(clip);
    setKeyJob("");
    const res = await fetch("/api/keying/status");
    if (res.ok) {
      setKeySidecar(
        (await res.json()) as {
          configured: boolean;
          reachable: boolean;
          managed: boolean;
          setup: string;
          error?: string;
          url: string | null;
        },
      );
    }
  }, [detail, selected]);

  const installKeying = useCallback(async () => {
    setInstalling(true);
    setError("");
    try {
      const res = await fetch("/api/keying/setup", { method: "POST" });
      if (!res.ok) {
        setError(`install failed to start: ${res.status}`);
        return;
      }
      for (let i = 0; i < 900; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const poll = await fetch("/api/keying/status");
        if (!poll.ok) continue;
        const status = (await poll.json()) as {
          configured: boolean;
          reachable: boolean;
          managed: boolean;
          setup: string;
          error?: string;
          url: string | null;
        };
        setKeySidecar(status);
        if (status.setup === "ready") return;
        if (status.setup === "failed") {
          setError(`install failed: ${status.error ?? "see vendor/corridorkey/setup.log"}`);
          return;
        }
      }
      setError("install is taking a long time — leave the dialog open, it will finish.");
    } finally {
      setInstalling(false);
    }
  }, []);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    const frame = frameCanvasRef.current;
    const paint = paintCanvasRef.current;
    if (!video || !frame || !paint || !video.videoWidth) {
      setError("preview has no frame yet — scrub onto the clip first");
      return;
    }
    frame.width = video.videoWidth;
    frame.height = video.videoHeight;
    paint.width = video.videoWidth;
    paint.height = video.videoHeight;
    frame.getContext("2d")?.drawImage(video, 0, 0);
    const pctx = paint.getContext("2d");
    if (pctx) {
      pctx.clearRect(0, 0, paint.width, paint.height);
      pctx.lineCap = "round";
      pctx.lineJoin = "round";
    }
  }, []);

  const paintAt = useCallback(
    (e: React.PointerEvent) => {
      const paint = paintCanvasRef.current;
      if (!paint) return;
      const rect = paint.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * paint.width;
      const y = ((e.clientY - rect.top) / rect.height) * paint.height;
      const ctx = paint.getContext("2d");
      if (!ctx) return;
      ctx.strokeStyle = paintColor === "white" ? "#fff" : "#000";
      ctx.fillStyle = paintColor === "white" ? "#fff" : "#000";
      ctx.lineWidth = brush;
      if (!painting.current) {
        ctx.beginPath();
        ctx.arc(x, y, brush / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    },
    [paintColor, brush],
  );

  const runKey = useCallback(
    async (withHint: boolean) => {
      if (!keyClip) return;
      setKeyBusy(true);
      setError("");
      try {
        const form = new FormData();
        form.append("clipId", keyClip.id);
        if (withHint) {
          const paint = paintCanvasRef.current;
          if (!paint || paint.width === 0) {
            setError("capture a frame and paint the subject first");
            setKeyBusy(false);
            return;
          }
          const hint = document.createElement("canvas");
          hint.width = paint.width;
          hint.height = paint.height;
          const hctx = hint.getContext("2d");
          if (!hctx) throw new Error("canvas unavailable");
          hctx.fillStyle = "#000";
          hctx.fillRect(0, 0, hint.width, hint.height);
          hctx.drawImage(paint, 0, 0);
          const blob = await new Promise<Blob | null>((resolve) => hint.toBlob(resolve, "image/png"));
          if (!blob) throw new Error("hint export failed");
          form.append("hint", blob, "hint.png");
        }
        const res = await fetch(`/api/video-projects/${projectId}/key`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          setError(`key request failed: ${(await res.json()).error ?? res.status}`);
          setKeyBusy(false);
          return;
        }
        const { jobId } = (await res.json()) as { jobId: string };
        setKeyJob(jobId);
        for (let i = 0; i < 240; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          const poll = await fetch(`/api/jobs/${jobId}`);
          if (!poll.ok) break;
          const job = (await poll.json()) as { state: string; failedReason?: string };
          if (job.state === "completed") {
            setKeyClip(null);
            setKeyJob("");
            await refresh();
            return;
          }
          if (job.state === "failed") {
            setError(`keying failed: ${job.failedReason ?? "unknown"}`);
            break;
          }
        }
        setError("still keying — the render will land on the Subject track when done.");
      } finally {
        setKeyBusy(false);
      }
    },
    [keyClip, projectId, refresh],
  );

  if (!detail) return <p className="muted">Loading editor…</p>;

  const step = tickStep(pxPerSec);
  const ticks: number[] = [];
  for (let t = 0; t <= duration + step * 1000; t += step * 1000) ticks.push(Math.round(t));
  const contentWidth = (Math.max(duration, 30000) / 1000) * pxPerSec + 240;
  const z = ZONES[zone] ?? ZONES.reels;
  const rawObj = media.find((m) => m.id === rawAsset) ?? null;
  const rawEnd = Math.max(
    1,
    rawObj?.duration_ms ?? 0,
    ...ranges.map((r) => r.end_ms),
    ...rawTakes.map((t) => t.end_ms),
    ...words.map((w) => w.end_ms),
  );

  return (
    <div className="ved">
      {error !== "" && <p className="note err">{error}</p>}
      <div className="ved-top">
        <div className="ved-preview">
          <div
            className="ved-screen"
            style={{ aspectRatio: `${detail.project.width} / ${detail.project.height}` }}
          >
            <video ref={videoRef} playsInline preload="auto" />
            <div className="ved-zone" style={{ top: 0, height: `${z.top * 100}%`, left: 0, right: 0 }} />
            <div
              className="ved-zone"
              style={{ bottom: 0, height: `${z.bottom * 100}%`, left: 0, right: 0 }}
            />
            <div
              className="ved-zone"
              style={{ left: 0, width: `${z.left * 100}%`, top: 0, bottom: 0 }}
            />
            <div
              className="ved-zone"
              style={{ right: 0, width: `${z.right * 100}%`, top: 0, bottom: 0 }}
            />
            {activeCaption && (
              <div
                className="ved-caption"
                style={{ fontFamily: captionFont.stack, fontWeight: captionFont.weight }}
              >
                {activeCaption.lines.map((line, i) => (
                  <div key={i}>{typeof line === "string" ? line : line.text}</div>
                ))}
              </div>
            )}
            {activeGraphics.map((g) => (
              <div
                key={g.id}
                className="ved-graphic"
                style={{
                  top: `${g.y_pct}%`,
                  color: g.color,
                  fontFamily: headingFont.stack,
                  fontWeight: headingFont.weight,
                }}
              >
                {g.text}
              </div>
            ))}
            {activeHf.map((h) =>
              posters[h.id] ? (
                <img
                  key={h.id}
                  className="ved-hfposter"
                  src={`/api/hyperframes/poster?hash=${posters[h.id]}`}
                  alt="Hyperframes overlay preview"
                />
              ) : (
                <div key={h.id} className="ved-hfbadge">
                  HF overlay — render a preview in the Graphics tab
                </div>
              ),
            )}
            {!previewClip && !rawPreview && <div className="ved-nosignal">No clip under playhead</div>}
            {rawPreview && <div className="ved-rawbadge">RAW · {rawAssetObj?.filename ?? ""}</div>}
          </div>
          <audio ref={audioRef} preload="auto" />
          <div className="row">
            <button onClick={() => setPlaying((p) => !p)}>
              {playing ? "Pause" : "Play"}
            </button>
            <span className="muted">
              {fmt(rawPreview ? rawPreview.atMs : playhead)} / {fmt(duration)}
            </span>
            <select value={zone} onChange={(e) => setZone(e.target.value)} aria-label="Safe zone">
              {Object.entries(ZONES).map(([key, value]) => (
                <option key={key} value={key}>
                  {value.label}
                </option>
              ))}
            </select>
            {rawPreview && (
              <button
                onClick={() => {
                  setRawPreview(null);
                  setPlaying(false);
                }}
              >
                Back to timeline
              </button>
            )}
          </div>
          <div className="row">
            <button onClick={() => setPxPerSec((p) => Math.min(400, p * 1.25))}>Zoom +</button>
            <button onClick={() => setPxPerSec((p) => Math.max(10, p / 1.25))}>Zoom −</button>
            <button onClick={() => void splitAtPlayhead()}>Split (S)</button>
            <button onClick={() => void deleteSelected()} disabled={!selected}>
              Delete (ripple)
            </button>
            <button onClick={() => setReviewMode((m) => !m)} className={reviewMode ? "primary" : ""}>
              Review: {reviewMode ? "on" : "off"}
            </button>
            <button onClick={() => void openKeyModal()} disabled={!selected}>
              Key subject…
            </button>
          </div>
          <div className="row">
            <label>
              Captions{" "}
              <select
                value={styleState.caption_font}
                onChange={(e) => void saveStyle({ caption_font: e.target.value })}
                aria-label="Caption font"
              >
                {BODY_FONTS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Headings{" "}
              <select
                value={styleState.heading_font}
                onChange={(e) => void saveStyle({ heading_font: e.target.value })}
                aria-label="Heading font"
              >
                {HEADING_FONTS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <label>
              <input
                type="checkbox"
                checked={burnCaps}
                onChange={(e) => setBurnCaps(e.target.checked)}
              />{" "}
              Burn captions
            </label>
            <button className="primary" disabled={exporting} onClick={() => void runExport()}>
              {exporting ? "Exporting…" : "Export MP4"}
            </button>
          </div>
          {exports.length > 0 && (
            <div className="ved-exports">
              {exports.map((x) => (
                <p key={x.id}>
                  <a href={`/api/exports/${x.id}/file`}>
                    {x.width}x{x.height} · {x.created_at.slice(0, 16).replace("T", " ")}
                  </a>
                </p>
              ))}
            </div>
          )}
        </div>
        <div className="ved-side">
          <div className="ved-panels">
          <div className="ved-rail" role="tablist" aria-label="Editor panels">
            <button role="tab" aria-selected={tab === "media"} className={tab === "media" ? "on" : ""} onClick={() => setTab("media")}>
              Media ({media.length})
            </button>
            <button role="tab" aria-selected={tab === "transcript"} className={tab === "transcript" ? "on" : ""} onClick={() => setTab("transcript")}>
              Transcript
            </button>
            <button role="tab" aria-selected={tab === "raw"} className={tab === "raw" ? "on" : ""} onClick={() => setTab("raw")}>
              RAW
            </button>
            <button role="tab" aria-selected={tab === "captions"} className={tab === "captions" ? "on" : ""} onClick={() => setTab("captions")}>
              Captions ({detail.captions.length})
            </button>
            <button role="tab" aria-selected={tab === "audio"} className={tab === "audio" ? "on" : ""} onClick={() => setTab("audio")}>
              Audio
            </button>
            <button role="tab" aria-selected={tab === "graphics"} className={tab === "graphics" ? "on" : ""} onClick={() => setTab("graphics")}>
              Graphics
            </button>
          </div>
          <div className="ved-pane">
          {tab === "media" && (
            <div className="ved-bin">
              <div className="row">
                <label className="ved-file">
                  Upload
                  <input
                    type="file"
                    accept="video/*,audio/*,image/*"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadFile(f);
                      e.target.value = "";
                    }}
                  />
                </label>
                <input
                  type="text"
                  placeholder="/path/to/footage.mp4"
                  value={registerPath}
                  onChange={(e) => setRegisterPath(e.target.value)}
                />
                <button onClick={() => void registerFile()}>Register in place</button>
              </div>
              {media.length === 0 && <p className="muted">No media yet. Upload or register footage.</p>}
              {media.map((m) => (
                <div key={m.id} className="ved-asset">
                  <div>
                    <strong>{m.filename}</strong>
                    <div className="muted">
                      {m.kind}
                      {m.duration_ms ? ` · ${fmt(m.duration_ms)}` : ""}
                    </div>
                  </div>
                  <div className="row">
                    {(m.kind === "video" || m.kind === "audio") && (
                      <button onClick={() => void transcribeAsset(m.id)}>Transcribe</button>
                    )}
                    {m.kind === "video" && (
                      <button onClick={() => void addAssetToTrack(m, "video")}>+ V1</button>
                    )}
                    {(m.kind === "video" || m.kind === "image") && (
                      <button onClick={() => void insertBroll(m)}>B-roll @ playhead</button>
                    )}
                    {m.kind === "audio" && (
                      <button onClick={() => void addAssetToTrack(m, "audio")}>+ A1</button>
                    )}
                    {m.kind === "image" && (
                      <button onClick={() => void addAssetToTrack(m, "video")}>+ V1 still</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {tab === "transcript" && (
            <div className="ved-transcript">
              <div className="row">
                <select
                  value={transcriptAsset}
                  onChange={(e) => void loadTranscript(e.target.value)}
                  aria-label="Transcript asset"
                >
                  <option value="">Pick footage…</option>
                  {media
                    .filter((m) => m.kind === "video" || m.kind === "audio")
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.filename}
                      </option>
                    ))}
                </select>
                <button onClick={() => void runAutocut()} disabled={!transcriptAsset}>
                  Auto-cut takes
                </button>
                <button onClick={() => void applyTakes()} disabled={takes.length === 0}>
                  Apply keeps to V1
                </button>
              </div>
              {transcriptAsset !== "" && words.length === 0 && (
                <p className="muted">No transcript yet — hit Transcribe in the Media tab.</p>
              )}
              <p className="ved-words">
                {words.map((w, i) => (
                  <span
                    key={i}
                    className={w.conf !== null && w.conf < 0.5 ? "ved-lowconf" : ""}
                    title={`${fmt(w.start_ms)} · ${(w.conf ?? 0).toFixed(2)}`}
                    onClick={() => jumpToWord(w)}
                  >
                    {w.word}{" "}
                  </span>
                ))}
              </p>
              {takes.length > 0 && (
                <div className="ved-takes">
                  {takes.map((t) => (
                    <div key={t.id} className={`ved-take ${t.verdict}`}>
                      <strong>
                        {t.label} · {t.verdict}
                      </strong>
                      <div className="muted">
                        {fmt(t.start_ms)}–{fmt(t.end_ms)}
                        {t.score !== null ? ` · score ${t.score}` : ""}
                      </div>
                      <div>{t.text}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {tab === "audio" && (
            <div className="ved-audio">
              <div className="row">
                <button
                  className={audioKind === "sfx" ? "primary" : ""}
                  onClick={() => setAudioKind("sfx")}
                >
                  SFX
                </button>
                <button
                  className={audioKind === "music" ? "primary" : ""}
                  onClick={() => setAudioKind("music")}
                >
                  Music
                </button>
                <input
                  type="text"
                  placeholder="Search free library (Wikimedia Commons)…"
                  value={audioQuery}
                  onChange={(e) => setAudioQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runCommonsSearch();
                  }}
                />
                <button onClick={() => void runCommonsSearch()} disabled={audioSearching}>
                  {audioSearching ? "Searching…" : "Search"}
                </button>
              </div>
              <div className="row">
                <label className="ved-file">
                  Upload
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadAudio(f);
                      e.target.value = "";
                    }}
                  />
                </label>
                <input
                  type="text"
                  placeholder="/path/to/sound.wav"
                  value={audioPath}
                  onChange={(e) => setAudioPath(e.target.value)}
                />
                <button onClick={() => void addLocalAudio()}>Add local file</button>
              </div>
              {commons.length > 0 && (
                <div className="ved-commons">
                  <h3>Free library results</h3>
                  {commons.map((r) => (
                    <div key={r.url} className="ved-asset">
                      <div>
                        <strong>{r.title}</strong>
                        <div className="muted">
                          {r.duration_ms ? fmt(r.duration_ms) : "?:??"}
                          {r.license ? ` · ${r.license}` : ""}
                          {r.artist ? ` · ${r.artist}` : ""}
                        </div>
                        {r.description && <div className="muted">{r.description}</div>}
                      </div>
                      <div className="row">
                        <button onClick={() => void fetchCommonsResult(r)}>Fetch</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <h3>My {audioKind === "sfx" ? "SFX" : "music"}</h3>
              {library.length === 0 && (
                <p className="muted">Empty — search the free library or add your own files.</p>
              )}
              {library.map((entry) => (
                <div key={entry.id} className="ved-asset">
                  <div>
                    <strong>{entry.title}</strong>
                    <div className="muted">
                      {entry.source}
                      {entry.duration_ms ? ` · ${fmt(entry.duration_ms)}` : ""}
                      {entry.license ? ` · ${entry.license}` : ""}
                    </div>
                    {entry.local_path && (
                      <audio controls preload="none" src={`/api/audio/${entry.id}/file`} />
                    )}
                  </div>
                  <div className="row">
                    <button onClick={() => void entryToTimeline(entry.id, false)}>+ A1</button>
                    <button onClick={() => void entryToTimeline(entry.id, true)}>@ playhead</button>
                    <button
                      onClick={async () => {
                        await fetch(`/api/audio/${entry.id}`, { method: "DELETE" });
                        await loadLibrary(audioKind);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {tab === "graphics" && (
            <div className="ved-gfx">
              <div className="row">
                <input
                  type="text"
                  placeholder="Heading text…"
                  value={gfxText}
                  onChange={(e) => setGfxText(e.target.value)}
                />
                <label>
                  Dur ms{" "}
                  <input
                    type="number"
                    min={500}
                    step={500}
                    value={gfxDur}
                    onChange={(e) => setGfxDur(Number(e.target.value))}
                  />
                </label>
                <label>
                  Y %{" "}
                  <input
                    type="number"
                    min={0}
                    max={90}
                    value={gfxY}
                    onChange={(e) => setGfxY(Number(e.target.value))}
                  />
                </label>
                <label>
                  Size{" "}
                  <input
                    type="number"
                    min={20}
                    max={200}
                    value={gfxSize}
                    onChange={(e) => setGfxSize(Number(e.target.value))}
                  />
                </label>
                <button onClick={() => void addGraphic()} disabled={!gfxText.trim()}>
                  Add at playhead
                </button>
              </div>
              <h3>Hyperframes overlay</h3>
              <p className="muted">
                Paste a standalone composition (transparent background, sized to the project).
                Creagent renders it to video once and composites it on export.
              </p>
              <textarea
                rows={6}
                placeholder="<!doctype html>…"
                value={hfHtml}
                onChange={(e) => setHfHtml(e.target.value)}
              />
              <div className="row">
                <button onClick={() => void addHyperframes()} disabled={!hfHtml.trim()}>
                  Add overlay at playhead ({fmt(gfxDur)})
                </button>
              </div>
              {detail.tracks
                .filter((t) => t.kind === "graphics")
                .flatMap((t) => t.clips)
                .filter((c) => {
                  try {
                    return (
                      (JSON.parse(c.payload) as { kind?: unknown }).kind === "hyperframes"
                    );
                  } catch {
                    return false;
                  }
                })
                .map((c) => (
                  <div key={c.id} className="ved-asset">
                    <div>
                      <strong>{c.name || "Hyperframes overlay"}</strong>
                      <div className="muted">
                        {fmt(c.start_ms)}–{fmt(c.start_ms + c.duration_ms)}
                      </div>
                      {posters[c.id] && (
                        <img
                          className="ved-posterthumb"
                          src={`/api/hyperframes/poster?hash=${posters[c.id]}`}
                          alt="overlay preview"
                        />
                      )}
                    </div>
                    <div className="row">
                      <button disabled={hfBusy} onClick={() => void renderHfPreview(c.id)}>
                        {hfBusy ? "Rendering…" : "Render preview"}
                      </button>
                      <button
                        onClick={async () => {
                          await fetch(`/api/video-projects/clips/${c.id}?ripple=0`, {
                            method: "DELETE",
                          });
                          await refresh();
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              <h3>Text cards</h3>
              <p className="muted">Text cards render on the preview and burn into the export.</p>
              {detail.tracks
                .filter((t) => t.kind === "graphics")
                .flatMap((t) => t.clips)
                .map((c) => {
                  let payload: {
                    kind?: unknown;
                    text?: unknown;
                    y_pct?: unknown;
                    fontsize?: unknown;
                  } = {};
                  try {
                    payload = JSON.parse(c.payload) as typeof payload;
                  } catch {
                    /* plain clip */
                  }
                  if (payload.kind === "hyperframes") return null;
                  return (
                    <div key={c.id} className="ved-asset">
                      <div>
                        <input
                          type="text"
                          defaultValue={typeof payload.text === "string" ? payload.text : ""}
                          key={`${c.id}-${String(payload.text ?? "")}`}
                          onBlur={(e) => void saveGraphic(c, { text: e.target.value })}
                        />
                        <div className="muted">
                          {fmt(c.start_ms)}–{fmt(c.start_ms + c.duration_ms)}
                        </div>
                      </div>
                      <div className="row">
                        <label>
                          Y{" "}
                          <input
                            type="number"
                            defaultValue={typeof payload.y_pct === "number" ? payload.y_pct : 12}
                            onBlur={(e) =>
                              void saveGraphic(c, { y_pct: Number(e.target.value) })
                            }
                          />
                        </label>
                        <button
                          onClick={async () => {
                            await fetch(`/api/video-projects/clips/${c.id}?ripple=0`, {
                              method: "DELETE",
                            });
                            await refresh();
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
          {tab === "captions" && (
            <div className="ved-caps">
              <div className="row">
                <select
                  value={capAsset}
                  onChange={(e) => setCapAsset(e.target.value)}
                  aria-label="Caption source"
                >
                  <option value="">Pick footage…</option>
                  {media
                    .filter((m) => m.kind === "video" || m.kind === "audio")
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.filename}
                      </option>
                    ))}
                </select>
                <label>
                  Words/line{" "}
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={capWpl}
                    onChange={(e) => setCapWpl(Number(e.target.value))}
                  />
                </label>
                <label>
                  Lines{" "}
                  <input
                    type="number"
                    min={1}
                    max={4}
                    value={capMaxLines}
                    onChange={(e) => setCapMaxLines(Number(e.target.value))}
                  />
                </label>
                <button onClick={() => void generateCaptions(true)} disabled={!capAsset}>
                  Generate (replace)
                </button>
                <button onClick={() => void generateCaptions(false)} disabled={!capAsset}>
                  Append
                </button>
                <button
                  onClick={async () => {
                    await fetch(`/api/video-projects/${projectId}/captions`, { method: "DELETE" });
                    await refresh();
                  }}
                >
                  Clear all
                </button>
              </div>
              {detail.captions.length === 0 && (
                <p className="muted">No captions. Generate from transcribed footage.</p>
              )}
              {detail.captions.map((b) => (
                <div key={b.id} className={`ved-cap${b.enabled ? "" : " off"}`}>
                  <div className="row">
                    <button onClick={() => setPlayhead(b.start_ms)}>
                      {fmt(b.start_ms)}–{fmt(b.end_ms)}
                    </button>
                    <label>
                      start{" "}
                      <input
                        type="number"
                        defaultValue={b.start_ms}
                        key={`s${b.id}${b.start_ms}`}
                        onBlur={(e) =>
                          void patchCaption(b.id, { start_ms: Number(e.target.value) })
                        }
                      />
                    </label>
                    <label>
                      end{" "}
                      <input
                        type="number"
                        defaultValue={b.end_ms}
                        key={`e${b.id}${b.end_ms}`}
                        onBlur={(e) => void patchCaption(b.id, { end_ms: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={b.enabled === 1}
                        onChange={(e) =>
                          void patchCaption(b.id, { enabled: e.target.checked ? 1 : 0 })
                        }
                      />{" "}
                      on
                    </label>
                    <button
                      onClick={async () => {
                        await fetch(`/api/video-projects/captions/${b.id}`, { method: "DELETE" });
                        await refresh();
                      }}
                    >
                      Delete
                    </button>
                  </div>
                  {b.lines.map((l, li) => (
                    <div key={li} className="ved-capline">
                      <div className="row">
                        <input
                          type="text"
                          defaultValue={typeof l === "string" ? l : l.text}
                          key={`${b.id}-${li}-${typeof l === "string" ? l : l.text}`}
                          onBlur={(e) => {
                            const text = e.target.value;
                            const lines = b.lines.map((old, i) =>
                              i === li
                                ? {
                                    text,
                                    start_ms: typeof old === "string" ? b.start_ms : old.start_ms,
                                    end_ms: typeof old === "string" ? b.end_ms : old.end_ms,
                                  }
                                : old,
                            );
                            void patchCaption(b.id, { lines });
                          }}
                        />
                        {li > 0 && (
                          <button onClick={() => void capAction(b.id, "split", { atLine: li })}>
                            Split above
                          </button>
                        )}
                      </div>
                      <div className="ved-capwords">
                        {(typeof l === "string" ? l : l.text)
                          .split(/\s+/)
                          .filter(Boolean)
                          .map((w, wi) => (
                            <span
                              key={wi}
                              className={
                                selWord?.block === b.id &&
                                selWord.line === li &&
                                selWord.word === wi
                                  ? "sel"
                                  : ""
                              }
                              onClick={() => setSelWord({ block: b.id, line: li, word: wi })}
                            >
                              {w}
                            </span>
                          ))}
                      </div>
                    </div>
                  ))}
                  <div className="row">
                    <button
                      disabled={
                        !selWord || selWord.block !== b.id || selWord.line === 0 || selWord.word !== 0
                      }
                      onClick={() =>
                        selWord &&
                        void capAction(b.id, "move-word", {
                          lineIndex: selWord.line,
                          wordIndex: selWord.word,
                          dir: -1,
                        })
                      }
                    >
                      Move word ↑
                    </button>
                    <button
                      disabled={
                        !selWord ||
                        selWord.block !== b.id ||
                        selWord.line >= b.lines.length - 1 ||
                        selWord.word !==
                          (typeof b.lines[selWord.line] === "string"
                            ? (b.lines[selWord.line] as unknown as string)
                                .split(/\s+/)
                                .filter(Boolean).length - 1
                            : b.lines[selWord.line].text.split(/\s+/).filter(Boolean).length - 1)
                      }
                      onClick={() =>
                        selWord &&
                        void capAction(b.id, "move-word", {
                          lineIndex: selWord.line,
                          wordIndex: selWord.word,
                          dir: 1,
                        })
                      }
                    >
                      Move word ↓
                    </button>
                    <button onClick={() => void capAction(b.id, "reflow", { wordsPerLine: capWpl })}>
                      Reflow to {capWpl} wpl
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {tab === "raw" && (
            <div className="ved-raw">
              <div className="row">
                <select
                  value={rawAsset}
                  onChange={(e) => void loadRaw(e.target.value)}
                  aria-label="RAW asset"
                >
                  <option value="">Pick footage…</option>
                  {media
                    .filter((m) => m.kind === "video" || m.kind === "audio")
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.filename}
                      </option>
                    ))}
                </select>
              </div>
              {rawAsset !== "" && (
                <>
                  <div className="ved-strip">
                    {ranges.map((r, i) => (
                      <div
                        key={i}
                        className="ved-used"
                        style={{
                          left: `${(r.start_ms / rawEnd) * 100}%`,
                          width: `${((r.end_ms - r.start_ms) / rawEnd) * 100}%`,
                        }}
                        title={`used ${fmt(r.start_ms)}–${fmt(r.end_ms)}`}
                      />
                    ))}
                    {rawTakes.map((t) => (
                      <div
                        key={t.id}
                        className={`ved-takemark ${t.verdict}`}
                        style={{
                          left: `${(t.start_ms / rawEnd) * 100}%`,
                          width: `${Math.max(0.5, ((t.end_ms - t.start_ms) / rawEnd) * 100)}%`,
                        }}
                        title={`${t.label} · ${t.verdict}`}
                        onClick={() => setRawPreview({ assetId: rawAsset, atMs: t.start_ms })}
                      />
                    ))}
                  </div>
                  <p className="muted">
                    Green bands are used on the timeline. Take marks: green keep, red cut, orange
                    unsure. Click a mark to preview it.
                  </p>
                  {rawTakes.map((t) => (
                    <div key={t.id} className={`ved-take ${t.verdict}`}>
                      <strong>{t.label}</strong>
                      <div className="muted">
                        {fmt(t.start_ms)}–{fmt(t.end_ms)}
                      </div>
                      <div>{t.text}</div>
                      <div className="row">
                        <button
                          onClick={() => setRawPreview({ assetId: rawAsset, atMs: t.start_ms })}
                        >
                          Preview
                        </button>
                        {t.verdict !== "keep" && (
                          <button onClick={() => void addTakeToTimeline(t)}>Use instead (+ V1)</button>
                        )}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
          </div>
          </div>
        </div>
      </div>
      <div className="ved-timeline">
        <div className="ved-scroll">
          <div ref={contentRef} className="ved-content" style={{ width: contentWidth }}>
            <div
              className="ved-ruler"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                setPlayhead(xToMs(e.clientX));
              }}
              onPointerMove={(e) => {
                if (e.buttons === 1) setPlayhead(xToMs(e.clientX));
              }}
            >
              {ticks.map((t) => (
                <span key={t} className="ved-tick" style={{ left: (t / 1000) * pxPerSec }}>
                  {fmt(t)}
                </span>
              ))}
            </div>
            {detail.tracks.map((t) => (
              <div key={t.id} className={`ved-lane kind-${t.kind}`}>
                <span className="ved-lanename">{t.name || t.kind}</span>
                {t.clips.map((c) => {
                  const o = over[c.id];
                  const s = o ?? c;
                  return (
                    <div
                      key={c.id}
                      className={`ved-clip${selected === c.id ? " sel" : ""}`}
                      style={{
                        left: (s.start_ms / 1000) * pxPerSec,
                        width: Math.max(8, (s.duration_ms / 1000) * pxPerSec),
                      }}
                      onPointerDown={(e) => beginDrag(e, c, "move")}
                    >
                      <span
                        className="ved-handle l"
                        onPointerDown={(e) => beginDrag(e, c, "trim-l")}
                      />
                      <span className="ved-clipname">{c.name || c.asset?.filename || "clip"}</span>
                      <span
                        className="ved-handle r"
                        onPointerDown={(e) => beginDrag(e, c, "trim-r")}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
            <div
              className={`ved-lane review${reviewMode ? " armed" : ""}`}
              onPointerDown={(e) => {
                if (!reviewMode) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                const ms = xToMs(e.clientX);
                reviewDrag.current = { from: ms };
                setNoteRange({ start: ms, end: ms });
              }}
              onPointerMove={(e) => {
                if (reviewDrag.current && e.buttons === 1) {
                  setNoteRange((r) => (r ? { ...r, end: xToMs(e.clientX) } : r));
                }
              }}
              onPointerUp={() => {
                reviewDrag.current = null;
              }}
            >
              <span className="ved-lanename">review</span>
              {detail.notes.map((n) => (
                <div
                  key={n.id}
                  className={`ved-notemark${n.status === "done" ? " done" : ""}`}
                  style={{
                    left: (n.start_ms / 1000) * pxPerSec,
                    width: Math.max(6, ((n.end_ms - n.start_ms) / 1000) * pxPerSec),
                  }}
                  title={n.body}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPlayhead(n.start_ms);
                  }}
                />
              ))}
              {noteRange && (
                <div
                  className="ved-notedraft"
                  style={{
                    left: (Math.min(noteRange.start, noteRange.end) / 1000) * pxPerSec,
                    width: Math.max(
                      6,
                      (Math.abs(noteRange.end - noteRange.start) / 1000) * pxPerSec,
                    ),
                  }}
                />
              )}
            </div>
            <div className="ved-playhead" style={{ left: (playhead / 1000) * pxPerSec }} />
          </div>
        </div>
      </div>
      {noteRange && (
        <div className="row">
          <span className="muted">
            {fmt(Math.min(noteRange.start, noteRange.end))}–
            {fmt(Math.max(noteRange.start, noteRange.end))}
          </span>
          <input
            type="text"
            placeholder="Review note for this range…"
            value={noteBody}
            onChange={(e) => setNoteBody(e.target.value)}
          />
          <button onClick={() => void saveNote()}>Save note</button>
          <button onClick={() => setNoteRange(null)}>Cancel</button>
        </div>
      )}
      {detail.notes.length > 0 && (
        <div className="ved-notes">
          {detail.notes.map((n) => (
            <div key={n.id} className="ved-noteitem">
              <button onClick={() => setPlayhead(n.start_ms)}>
                {fmt(n.start_ms)}–{fmt(n.end_ms)}
              </button>
              <span className={n.status === "done" ? "muted" : ""}>{n.body}</span>
              <button
                onClick={async () => {
                  await fetch(`/api/video-projects/notes/${n.id}`, {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ status: n.status === "done" ? "open" : "done" }),
                  });
                  await refresh();
                }}
              >
                {n.status === "done" ? "Reopen" : "Done"}
              </button>
              <button
                onClick={async () => {
                  await fetch(`/api/video-projects/notes/${n.id}`, { method: "DELETE" });
                  await refresh();
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
      {keyClip && (
        <div className="overlay">
          <div className="dialog ved-keydialog">
            <h2>Key subject — {keyClip.name || "clip"}</h2>
            {keySidecar?.managed && keySidecar.setup !== "ready" && (
              <div className="note">
                <p>
                  CorridorKey isn&apos;t installed yet. One click downloads it plus torch (~2GB,
                  once) into the project&apos;s vendor folder.
                  {installing || keySidecar.setup === "installing"
                    ? " Installing — this takes several minutes."
                    : ""}
                </p>
                <button
                  className="primary"
                  disabled={installing || keySidecar.setup === "installing"}
                  onClick={() => void installKeying()}
                >
                  {installing || keySidecar.setup === "installing"
                    ? "Installing…"
                    : keySidecar.setup === "failed"
                      ? "Retry install"
                      : "Install CorridorKey"}
                </button>
                {keySidecar.setup === "failed" && keySidecar.error && (
                  <p className="note err">{keySidecar.error}</p>
                )}
              </div>
            )}
            {keySidecar && !keySidecar.managed && !keySidecar.reachable && (
              <p className="note err">
                Remote sidecar not responding ({keySidecar.url}): {keySidecar.error ?? "no response"}.
              </p>
            )}
            {keySidecar?.managed && keySidecar.setup === "ready" && !keySidecar.reachable && (
              <p className="muted">Sidecar is asleep — it starts automatically on the first run.</p>
            )}
            <div className="ved-paintstack">
              <canvas ref={frameCanvasRef} className="ved-frame" />
              <canvas
                ref={paintCanvasRef}
                className="ved-paint"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  painting.current = false;
                  paintAt(e);
                  painting.current = true;
                }}
                onPointerMove={(e) => {
                  if (e.buttons === 1) paintAt(e);
                }}
                onPointerUp={() => {
                  painting.current = false;
                }}
              />
            </div>
            <div className="row">
              <button onClick={captureFrame}>Capture preview frame</button>
              <button
                className={paintColor === "white" ? "primary" : ""}
                onClick={() => setPaintColor("white")}
              >
                Subject (white)
              </button>
              <button
                className={paintColor === "black" ? "primary" : ""}
                onClick={() => setPaintColor("black")}
              >
                Background (black)
              </button>
              <label>
                Brush{" "}
                <input
                  type="number"
                  min={4}
                  max={200}
                  value={brush}
                  onChange={(e) => setBrush(Number(e.target.value))}
                />
              </label>
              <button
                onClick={() => {
                  const paint = paintCanvasRef.current;
                  paint?.getContext("2d")?.clearRect(0, 0, paint.width, paint.height);
                }}
              >
                Clear paint
              </button>
            </div>
            <div className="row">
              <button
                className="primary"
                disabled={
                  keyBusy ||
                  !keySidecar ||
                  (!keySidecar.reachable &&
                    keySidecar.setup !== "ready" &&
                    !(!keySidecar.managed && keySidecar.configured))
                }
                onClick={() => void runKey(true)}
              >
                {keyBusy ? "Keying…" : "Run key with hint"}
              </button>
              <button
                disabled={
                  keyBusy ||
                  !keySidecar ||
                  (!keySidecar.reachable &&
                    keySidecar.setup !== "ready" &&
                    !(!keySidecar.managed && keySidecar.configured))
                }
                onClick={() => void runKey(false)}
              >
                Run key without hint
              </button>
              <button disabled={keyBusy} onClick={() => setKeyClip(null)}>
                Close
              </button>
              {keyJob !== "" && <span className="muted">job {keyJob.slice(0, 8)}…</span>}
            </div>
            <p className="muted">
              Paint white over the subject. The Luma hint ships with the first frame so CorridorKey
              holds the matte without a green screen. The render lands on the Subject track.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
