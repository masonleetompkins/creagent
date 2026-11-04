"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CONTENT_TYPES, PLATFORM_POST_CAPS, PLATFORMS, THREAD_KINDS } from "@/lib/content";
import DraftReview from "./draft-review";
import {
  approvedBody,
  charCount,
  clampSelection,
  longestParagraph,
  parseStructure,
  splitLegacyOptions,
} from "@/lib/draft-structure";

type Slot = {
  id: string;
  scheduled_at: string;
  pillar_id: string | null;
  pillar_name: string | null;
  content_type: string;
  platforms: string;
  status: string;
  draft_count: number;
  approved_draft_id?: string | null;
  approved_option?: number | null;
};

type Draft = {
  id: string;
  kind: string;
  body: string;
  status: string;
  structure: string | null;
  selection: string | null;
  created_at: string;
};

type Attachment = {
  id: string;
  kind: string;
  filename: string;
  mime: string;
  size: number;
};

type GenRequest = {
  id: string;
  slide_id: string | null;
  prompt: string;
  status: string;
  created_at: string;
};

type Template = {
  id: string;
  name: string;
  weekday: number;
  time: string;
  pillar_id: string | null;
  pillar_name: string | null;
  content_type: string;
  platforms: string;
};

type Pillar = {
  id: string;
  name: string;
  byPlatform?: Record<string, { posts: number; multiplier: number | null }>;
};

type HistoryAsset = {
  id: string;
  source: string;
  title: string;
  source_url: string | null;
  posted_at: string | null;
  created_at: string;
};

type PublishReceipt = {
  platform: string;
  username: string;
  payload: string;
  status: string;
  postUrl: string | null;
  error: string | null;
};

type PublishHistoryRow = {
  attempt: number;
  platform: string;
  username: string;
  payload: string;
  status: string;
  postUrl: string | null;
  error: string | null;
  createdAt: string;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Mirrors IN_FLIGHT in lib/publish — receipts Zernio still holds.
const IN_FLIGHT = new Set(["scheduled", "pending", "processing", "uploading", "publishing"]);

const SOURCE_SHORT: Record<string, string> = {
  x_posts: "X",
  tiktok_videos: "TikTok",
  instagram_posts: "IG",
  youtube_transcript: "YT",
  instagram_reel: "Reel",
  zernio_instagram: "IG",
  zernio_youtube: "YT",
  zernio_linkedin: "LI",
  zernio_threads: "TH",
  zernio_tiktok: "TT",
  zernio_twitter: "X",
  zernio_facebook: "FB",
};

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

function parsePlatforms(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Tightest single-post cap across the slot's platforms — the N/Total every
// count is measured against. Null when no platform publishes a cap.
function slotCap(platformsJson: string): number | null {
  const caps = parsePlatforms(platformsJson)
    .map((p) => PLATFORM_POST_CAPS[p])
    .filter((n): n is number => n !== undefined);
  return caps.length > 0 ? Math.min(...caps) : null;
}

function isThreadKind(contentType: string): boolean {
  return THREAD_KINDS.has(contentType);
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function summarizeResult(result: unknown): string {
  if (typeof result !== "object" || result === null) return "done.";
  const r = result as Record<string, unknown>;
  if (typeof r.drafted === "number") {
    const failures = Array.isArray(r.failures) ? r.failures.length : 0;
    const skipped = typeof r.skipped === "number" ? r.skipped : 0;
    return `${r.drafted} drafted, ${skipped} skipped${failures > 0 ? `, ${failures} failed` : ""}.`;
  }
  if (typeof r.created === "number") {
    const bits = [`${r.created} created`];
    if (typeof r.synced === "number" && r.synced > 0) bits.push(`${r.synced} synced to setup`);
    if (typeof r.rolled === "number" && r.rolled > 0) bits.push(`${r.rolled} rolled forward`);
    if (typeof r.stuck === "number" && r.stuck > 0) bits.push(`${r.stuck} stuck`);
    return `${bits.join(", ")}.`;
  }
  return `${JSON.stringify(result).slice(0, 200)}`;
}

function typeLabel(t: string): string {
  return (CONTENT_TYPES as Record<string, { label: string }>)[t]?.label ?? t;
}

const QUARTERS: string[] = Array.from({ length: 96 }, (_, i) => {
  const h = String(Math.floor(i / 4)).padStart(2, "0");
  const m = String((i % 4) * 15).padStart(2, "0");
  return `${h}:${m}`;
});

const PLAT_LABEL: Record<string, string> = {
  x: "X",
  threads: "Threads",
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  linkedin: "LinkedIn",
};

function fitStat(
  pillars: Pillar[],
  pillarId: string | null,
  platform: string,
): { posts: number; multiplier: number | null } | null {
  if (!pillarId) return null;
  return pillars.find((p) => p.id === pillarId)?.byPlatform?.[platform] ?? null;
}

function isWeakStat(st: { posts: number; multiplier: number | null } | null): boolean {
  return !!st && st.multiplier !== null && st.posts > 0 && st.multiplier < 0.7;
}

function isDone(status: string): boolean {
  return status === "green" || status === "gray";
}

function optionCountOf(d: Draft): number {
  return parseStructure(d.structure)?.options.length ?? splitLegacyOptions(d.body)?.length ?? 1;
}

export default function QueueConsole(): React.ReactNode {
  const [view, setView] = useState<"week" | "month">("week");
  const [weekOffset, setWeekOffset] = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [history, setHistory] = useState<HistoryAsset[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [pillars, setPillars] = useState<Pillar[]>([]);
  const [selected, setSelected] = useState<(Slot & { drafts?: Draft[] }) | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [genRequests, setGenRequests] = useState<GenRequest[]>([]);
  const [editing, setEditing] = useState<{
    id: string;
    body: string;
    target: number | "thread" | null;
    title: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [agentInput, setAgentInput] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentNote, setAgentNote] = useState<string | null>(null);
  const [anyRed, setAnyRed] = useState(true);
  const [bankCount, setBankCount] = useState(0);
  const [draftingIds, setDraftingIds] = useState<Set<string>>(new Set());
  const [jobProgress, setJobProgress] = useState<{ done: number; total: number } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{
    ok: boolean;
    error?: string;
    receipts?: PublishReceipt[];
  } | null>(null);
  const [publishHistory, setPublishHistory] = useState<PublishHistoryRow[]>([]);
  const agentBoxRef = useRef<HTMLTextAreaElement | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );
  const [feedback, setFeedback] = useState<{ draftId: string; body: string; standing: boolean } | null>(
    null,
  );
  const [feedbackStatus, setFeedbackStatus] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    weekday: "1",
    time: "09:00",
    pillar_id: "",
    content_type: "short_post",
    platforms: [] as string[],
  });

  const weekStart = useCallback(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay() + weekOffset * 7);
    return d;
  }, [weekOffset]);

  const monthGridStart = useCallback(() => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    first.setHours(0, 0, 0, 0);
    first.setDate(first.getDate() - first.getDay());
    return first;
  }, [monthOffset]);

  const refresh = useCallback(async () => {
    try {
      const start = view === "week" ? weekStart() : monthGridStart();
      const end = new Date(start);
      end.setDate(end.getDate() + (view === "week" ? 7 : 42));
      const range = `from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`;
      const horizonRange = `from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(
        new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
      )}`;
      const [slotData, tmplData, pillarData, assetData, horizonData, bankData] = await Promise.all([
        readJson(await fetch(`/api/slots?${range}`)),
        readJson(await fetch("/api/templates")),
        readJson(await fetch("/api/pillars")),
        readJson(await fetch(`/api/assets?${range}&limit=500`)),
        readJson(await fetch(`/api/slots?${horizonRange}`)),
        readJson(await fetch("/api/bank")),
      ]);
      setSlots(slotData.slots as Slot[]);
      setAnyRed(((horizonData.slots as Slot[]) ?? []).some((sl) => sl.status === "red"));
      setBankCount(typeof bankData.count === "number" ? bankData.count : 0);
      setTemplates(tmplData.templates as Template[]);
      setPillars((pillarData.pillars as Pillar[]) ?? []);
      setHistory((assetData.assets as HistoryAsset[]) ?? []);
      setTemplatesLoaded(true);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [weekStart, monthGridStart, view]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (templatesLoaded && templates.length === 0) setSetupOpen(true);
  }, [templatesLoaded, templates.length]);

  useEffect(() => {
    if (!setupOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setSetupOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setupOpen]);

  async function runJob(url: string, body: unknown, label: string): Promise<void> {
    setBusy(true);
    setNote(null);
    setError(null);
    const targetSlot =
      typeof body === "object" && body !== null && typeof (body as { slotId?: unknown }).slotId === "string"
        ? ((body as { slotId: string }).slotId as string)
        : null;
    if (targetSlot) {
      setDraftingIds((prev) => new Set(prev).add(targetSlot));
    }
    try {
      const started = await readJson(
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      const done = await pollJob(started.jobId as string, (d) => {
        const prog = (d.progress ?? {}) as { done?: unknown; total?: unknown };
        if (typeof prog.done === "number" && typeof prog.total === "number" && prog.total > 0) {
          setJobProgress({ done: prog.done, total: prog.total });
        }
      });
      if (done.state === "failed") throw new Error((done.failedReason as string) ?? "job failed");
      reportResult(label, done.result);
      await refresh();
      if (targetSlot) await openSlot(targetSlot);
      else setSelected(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setJobProgress(null);
      if (targetSlot) {
        setDraftingIds((prev) => {
          const next = new Set(prev);
          next.delete(targetSlot);
          return next;
        });
      }
    }
  }

  function reportResult(label: string, result: unknown): void {
    const summary = summarizeResult(result);
    const r = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
    const failures = Array.isArray(r.failures) ? (r.failures as { error?: unknown }[]) : [];
    const drafted = typeof r.drafted === "number" ? r.drafted : -1;
    if (failures.length > 0 && drafted === 0) {
      const first = typeof failures[0]?.error === "string" ? (failures[0].error as string) : "unknown error";
      setError(`${label}: all ${failures.length} failed. First error: ${first.slice(0, 220)}`);
      return;
    }
    if (failures.length > 0) {
      const first = typeof failures[0]?.error === "string" ? (failures[0].error as string) : "unknown error";
      setNote(`${label}: ${summary} First error: ${first.slice(0, 160)}`);
      return;
    }
    setNote(`${label}: ${summary}`);
  }

  async function openSlot(id: string): Promise<void> {
    setVersionsOpen(null);
    setCopied(false);
    setPublishResult(null);
    try {
      const [data, files, reqs, pubs] = await Promise.all([
        readJson(await fetch(`/api/slots/${id}/drafts`)),
        readJson(await fetch(`/api/slots/${id}/attachments`)),
        readJson(await fetch(`/api/slots/${id}/gen-requests`)),
        readJson(await fetch(`/api/slots/${id}/publish`)),
      ]);
      setPublishHistory((pubs.history as PublishHistoryRow[]) ?? []);
      setSelected({ ...((data.slot as Slot) ?? {}), drafts: (data.drafts as Draft[]) ?? [] } as Slot & {
        drafts: Draft[];
      });
      setAttachments((files.attachments as Attachment[]) ?? []);
      setGenRequests((reqs.requests as GenRequest[]) ?? []);
      requestAnimationFrame(() => {
        document
          .querySelector(".slot-inspector")
          ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function decideRequest(slotId: string, id: string, decision: "approve" | "reject"): Promise<void> {
    try {
      await readJson(await fetch(`/api/gen-requests/${id}/${decision}`, { method: "POST" }));
      await openSlot(slotId);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function uploadFile(slotId: string, file: File | undefined): Promise<void> {
    if (!file) return;
    try {
      const form = new FormData();
      form.append("file", file);
      await readJson(
        await fetch(`/api/slots/${slotId}/attachments`, { method: "POST", body: form }),
      );
      await openSlot(slotId);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeAttachment(slotId: string, attachmentId: string): Promise<void> {
    try {
      await readJson(await fetch(`/api/attachments/${attachmentId}`, { method: "DELETE" }));
      await openSlot(slotId);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function setStatus(id: string, status: string): Promise<void> {
    try {
      await readJson(
        await fetch(`/api/slots/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        }),
      );
      await refresh();
      await openSlot(id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function markPosted(id: string): Promise<void> {
    if (publishHistory.some((h) => IN_FLIGHT.has(h.status))) {
      setPublishResult({
        ok: false,
        error:
          "This slot is still scheduled on Zernio — Cancel scheduled first, or it will fire on top of your manual post.",
      });
      return;
    }
    try {
      await readJson(await fetch(`/api/slots/${id}/post`, { method: "POST" }));
      await refresh();
      await openSlot(id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function reopenSlot(id: string): Promise<void> {
    if (publishHistory.some((h) => IN_FLIGHT.has(h.status))) {
      setPublishResult({
        ok: false,
        error:
          "Cancel the scheduled post first — it's still live on Zernio and would ship the old text.",
      });
      return;
    }
    await setStatus(id, "orange");
  }

  async function publishNow(id: string): Promise<void> {
    setPublishing(true);
    setPublishResult(null);
    try {
      const data = await readJson(await fetch(`/api/slots/${id}/publish`, { method: "POST" }));
      setPublishResult({
        ok: data.ok === true,
        error: typeof data.error === "string" ? data.error : undefined,
        receipts: (data.receipts as PublishReceipt[]) ?? [],
      });
      await refresh();
      if (data.ok === true) await openSlot(id);
    } catch (e) {
      setPublishResult({ ok: false, error: (e as Error).message });
    } finally {
      setPublishing(false);
    }
  }

  async function cancelScheduled(id: string): Promise<void> {
    setPublishing(true);
    setPublishResult(null);
    try {
      const data = await readJson(
        await fetch(`/api/slots/${id}/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "cancel" }),
        }),
      );
      showToast(`Cancelled ${data.cancelled as number} scheduled post(s)`);
      await refresh();
      await openSlot(id);
    } catch (e) {
      setPublishResult({ ok: false, error: (e as Error).message });
    } finally {
      setPublishing(false);
    }
  }

  async function copyPost(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copy failed — select the text manually.");
    }
  }

  async function selectOption(draftId: string, index: number): Promise<void> {
    try {
      await readJson(
        await fetch(`/api/drafts/${draftId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selection: String(index) }),
        }),
      );
      setSelected((prev) =>
        prev
          ? {
              ...prev,
              drafts: (prev.drafts ?? []).map((d) =>
                d.id === draftId ? { ...d, selection: String(index) } : d,
              ),
            }
          : prev,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveEdit(): Promise<void> {
    if (!editing || !selected) return;
    try {
      const payload =
        editing.target === null
          ? { body: editing.body }
          : editing.target === "thread"
            ? { threadBody: editing.body }
            : { optionIndex: editing.target, body: editing.body };
      await readJson(
        await fetch(`/api/drafts/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
      setEditing(null);
      await openSlot(selected.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function clearQueue(): Promise<void> {
    if (
      !window.confirm(
        `Clear all ${slots.length} slots, every draft, and the option bank? Your queue setup, pillars, and style rules are kept.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const data = await readJson(await fetch("/api/slots?confirm=all", { method: "DELETE" }));
      const c = (data.cleared ?? {}) as { slots?: number; drafts?: number };
      setNote(
        `Cleared ${c.slots ?? 0} slots and ${c.drafts ?? 0} drafts. Setup kept — Plan 14 days to regenerate.`,
      );
      setSelected(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function fillFromBank(): Promise<void> {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const data = await readJson(await fetch("/api/bank/fill", { method: "POST" }));
      const placed = typeof data.placed === "number" ? data.placed : 0;
      const skipped = typeof data.skipped === "number" ? data.skipped : 0;
      setNote(
        placed === 0
          ? "No matching red slots — banked posts need the same content type, spaced 3+ days apart."
          : `Placed ${placed} banked post${placed === 1 ? "" : "s"} into upcoming slots${skipped > 0 ? ` (${skipped} still banked)` : ""}.`,
      );
      await refresh();
      if (selected) await openSlot(selected.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendFeedback(slotId: string, mode: "refine" | "set"): Promise<void> {
    if (!selected || !feedback || feedback.body.trim().length === 0) return;
    setBusy(true);
    setNote(null);
    setError(null);
    setJobProgress({ done: 0, total: 0 });
    setFeedbackStatus(mode === "set" ? "Regenerating all options…" : "Refining your pick…");
    try {
      const started = await readJson(
        await fetch("/api/draft/redraft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slotId, feedback: feedback.body, mode, standing: feedback.standing }),
        }),
      );
      const done = await pollJob(started.jobId as string, (d) => {
        const prog = (d.progress ?? {}) as { stage?: unknown };
        if (typeof prog.stage === "string" && prog.stage) setFeedbackStatus(prog.stage);
      });
      if (done.state === "failed") throw new Error((done.failedReason as string) ?? "job failed");
      setFeedback(null);
      setNote(
        `${mode === "set" ? "New set generated" : "Picked option refined"} with your feedback. ${(done.result as { hint?: string })?.hint ?? ""}`.trim(),
      );
      await refresh();
      await openSlot(slotId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setJobProgress(null);
      setFeedbackStatus(null);
    }
  }

  async function openVideo(slot: Slot): Promise<void> {
    try {
      const list = await readJson(await fetch("/api/video-projects"));
      const existing = ((list.projects ?? []) as { id: string; slot_id: string | null }[]).find(
        (p) => p.slot_id === slot.id,
      );
      if (existing) {
        window.location.href = `/videos/${existing.id}`;
        return;
      }
      const data = await readJson(
        await fetch("/api/video-projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: `${typeLabel(slot.content_type)} — ${new Date(slot.scheduled_at).toLocaleDateString()}`,
            slot_id: slot.id,
          }),
        }),
      );
      const project = data.project as { id: string };
      window.location.href = `/videos/${project.id}`;
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function imageDraft(slot: Slot): Promise<void> {
    try {
      setBusy(true);
      const data = await readJson(await fetch(`/api/slots/${slot.id}/carousel-draft`, { method: "POST" }));
      window.location.href = `/carousels/${(data as { projectId: string }).projectId}`;
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
  }

  async function openCarousel(slot: Slot): Promise<void> {
    try {
      const list = await readJson(await fetch("/api/carousels"));
      const existing = ((list.projects ?? []) as { id: string; slot_id: string | null }[]).find(
        (p) => p.slot_id === slot.id,
      );
      if (existing) {
        window.location.href = `/carousels/${existing.id}`;
        return;
      }
      const data = await readJson(
        await fetch("/api/carousels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: `${typeLabel(slot.content_type)} — ${new Date(slot.scheduled_at).toLocaleDateString()}`,
            slot_id: slot.id,
          }),
        }),
      );
      const project = data.project as { id: string };
      window.location.href = `/carousels/${project.id}`;
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeSlot(id: string): Promise<void> {
    if (!window.confirm("Delete this slot and its drafts?")) return;
    try {
      await readJson(await fetch(`/api/slots/${id}`, { method: "DELETE" }));
      setSelected(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function addTemplate(): Promise<void> {
    const days =
      draft.weekday === "all" ? [0, 1, 2, 3, 4, 5, 6] : [Number(draft.weekday)];
    const plats = draft.platforms.slice().sort();
    if (plats.length === 0) {
      setNote("Check at least one platform — nothing added.");
      return;
    }
    let created = 0;
    let skipped = 0;
    try {
      for (const weekday of days) {
        if (templates.some(
          (t) =>
            t.weekday === weekday &&
            t.time === draft.time &&
            (t.pillar_id ?? "") === (draft.pillar_id || "") &&
            t.content_type === draft.content_type &&
            JSON.stringify(parsePlatforms(t.platforms).slice().sort()) === JSON.stringify(plats),
        )) {
          skipped++;
          continue;
        }
        await readJson(
          await fetch("/api/templates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              weekday,
              time: draft.time,
              pillar_id: draft.pillar_id || null,
              content_type: draft.content_type,
              platforms: plats,
            }),
          }),
        );
        created++;
      }
      setNote(
        created === 0
          ? "Those slots already exist — nothing added."
          : `Added ${created} slot${created === 1 ? "" : "s"}${skipped > 0 ? ` (${skipped} already existed)` : ""}.`,
      );
      if (created > 0) setAdding(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeTemplate(id: string): Promise<void> {
    try {
      await readJson(await fetch(`/api/templates/${id}`, { method: "DELETE" }));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function agentChatId(): Promise<string> {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem("creagent.activeChat");
    } catch {
      /* ignore */
    }
    const list = (await readJson(await fetch("/api/agent/chats"))) as { chats: { id: string }[] };
    if (stored && list.chats.some((c) => c.id === stored)) return stored;
    if (list.chats[0]) {
      try {
        localStorage.setItem("creagent.activeChat", list.chats[0].id);
      } catch {
        /* ignore */
      }
      return list.chats[0].id;
    }
    const created = (await readJson(await fetch("/api/agent/chats", { method: "POST" }))) as { chatId: string };
    try {
      localStorage.setItem("creagent.activeChat", created.chatId);
    } catch {
      /* ignore */
    }
    return created.chatId;
  }

  async function askAgent(): Promise<void> {
    const text = agentInput.trim();
    if (!text || agentBusy) return;
    setAgentBusy(true);
    setAgentNote(null);
    setError(null);
    try {
      const id = await agentChatId();
      const started = (await readJson(
        await fetch(`/api/agent/chats/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: `Set up my posting queue as follows: ${text}\n\nRules: weekdays are 0=Sunday..6=Saturday. First call list_templates to see the current schedule, list_pillars for pillar names, and pillar_fit for measured pillar×platform multiples. Use add_template for each slot (everyday=true for daily cadences) and delete_template to remove ones I no longer want. Always assign every slot the best-fit confirmed pillar, even when I don't name one — never leave pillar blank unless I have no confirmed pillars. Prefer pillar×platform combos at or above 1.0x; if I ask for a combo under 0.7x, schedule it but warn me about the multiple. When the templates are right, call run_planner once to materialize slots, then reply with a short summary of the schedule including which pillar each slot uses.`,
          }),
        }),
      )) as { jobId: string };
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const job = (await readJson(await fetch(`/api/jobs/${started.jobId}`))) as {
          state: string;
          failedReason?: string;
        };
        if (job.state === "completed") break;
        if (job.state === "failed") throw new Error(job.failedReason ?? "agent turn failed");
      }
      setAgentInput("");
      if (agentBoxRef.current) agentBoxRef.current.style.height = "auto";
      setAgentNote("Done — the schedule below is updated. The full conversation is in the agent panel.");
      window.dispatchEvent(new CustomEvent("creagent:agent-updated"));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAgentBusy(false);
    }
  }

  async function setTemplatePillar(ids: string[], pillarId: string): Promise<void> {
    try {
      await Promise.all(
        ids.map(async (id) =>
          readJson(
            await fetch(`/api/templates/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pillar_id: pillarId || null }),
            }),
          ),
        ),
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function setTemplatePlatforms(ids: string[], platforms: string[]): Promise<void> {
    try {
      await Promise.all(
        ids.map(async (id) =>
          readJson(
            await fetch(`/api/templates/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ platforms }),
            }),
          ),
        ),
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function removeDaily(ids: string[]): Promise<void> {
    if (!window.confirm(`Delete this daily slot (all ${ids.length} days)?`)) return;
    try {
      await Promise.all(
        ids.map(async (id) => readJson(await fetch(`/api/templates/${id}`, { method: "DELETE" }))),
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const start = view === "week" ? weekStart() : monthGridStart();
  const dayCount = view === "week" ? 7 : 42;
  const days = Array.from({ length: dayCount }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
  const monthLabel =
    view === "month"
      ? days[15].toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : "";
  const goPrev = (): void => {
    if (view === "week") setWeekOffset((o) => o - 1);
    else setMonthOffset((o) => o - 1);
  };
  const goToday = (): void => {
    setWeekOffset(0);
    setMonthOffset(0);
  };
  const goNext = (): void => {
    if (view === "week") setWeekOffset((o) => o + 1);
    else setMonthOffset((o) => o + 1);
  };
  const isVideoType = (t: string): boolean =>
    ["video_trend", "video_series", "video_yap", "long_video", "clip"].includes(t);
  const byDay = (day: Date): Slot[] =>
    slots.filter((s) => {
      const t = new Date(s.scheduled_at);
      return (
        t.getFullYear() === day.getFullYear() &&
        t.getMonth() === day.getMonth() &&
        t.getDate() === day.getDate()
      );
    });
  const historyByDay = (day: Date): HistoryAsset[] =>
    history.filter((a) => {
      const t = new Date(a.posted_at ?? a.created_at);
      return (
        t.getFullYear() === day.getFullYear() &&
        t.getMonth() === day.getMonth() &&
        t.getDate() === day.getDate()
      );
    });

  return (
    <>
      <div className="toolbar">
        <button disabled={busy} onClick={() => void runJob("/api/plan/run", { days: 14 }, "Planned")}>
          Plan 14 days
        </button>
        <button
          disabled={busy}
          aria-disabled={!anyRed}
          className={anyRed ? "" : "ghosted"}
          onClick={() => {
            if (anyRed) {
              void runJob("/api/draft/run", { limit: 10 }, "Drafted");
              return;
            }
            showToast(
              templates.length === 0
                ? "No schedule yet — add posting times in Queue setup first."
                : "Nothing red to draft — hit Plan 14 days first to materialize your schedule.",
            );
          }}
        >
          Draft all red
        </button>
        {toast ? (
          <div className="toast" role="status" onClick={() => setToast(null)}>
            {toast}
          </div>
        ) : null}
        <button
          disabled={busy}
          aria-disabled={bankCount === 0}
          className={bankCount === 0 ? "ghosted" : ""}
          onClick={() => {
            if (bankCount === 0) {
              showToast("Bank is empty — open a draft, toggle Bank options, right-click runners-up.");
              return;
            }
            void fillFromBank();
          }}
        >
          {`Fill from bank${bankCount > 0 ? ` (${bankCount})` : ""}`}
        </button>
        <button
          disabled={busy}
          onClick={() => setSetupOpen(true)}
          className={setupOpen ? "primary" : ""}
        >
          Queue setup
        </button>
        <button disabled={busy} className="danger" onClick={() => void clearQueue()}>
          Clear queue
        </button>
        <span className="spacer" />
        <div className="seg">
          <button onClick={() => setView("week")} className={view === "week" ? "on" : ""}>
            Week
          </button>
          <button onClick={() => setView("month")} className={view === "month" ? "on" : ""}>
            Month
          </button>
        </div>
        <button onClick={goPrev} aria-label="Previous period">
          ←
        </button>
        <button onClick={goToday} aria-label="Today">
          Today
        </button>
        <button onClick={goNext} aria-label="Next period">
          →
        </button>
        {view === "month" ? (
          <strong>{monthLabel}</strong>
        ) : (
          <strong>
            {days[0].toLocaleDateString([], { month: "short", day: "numeric" })} –{" "}
            {days[6].toLocaleDateString([], { month: "short", day: "numeric" })}
          </strong>
        )}
      </div>
      {busy ? (
        jobProgress ? (
          <div className="progress-wrap">
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{ width: `${Math.round((jobProgress.done / jobProgress.total) * 100)}%` }}
              />
            </div>
            <p className="muted">
              {jobProgress.done}/{jobProgress.total} slots…
            </p>
          </div>
        ) : (
          <p className="muted">Working…</p>
        )
      ) : null}
      {note ? <p className="note ok">{note}</p> : null}
      {error ? <p className="note err">{error}</p> : null}

      {templatesLoaded && templates.length === 0 && !setupOpen ? (
        <div className="empty">
          <p>No posting schedule yet — the calendar is blank until Queue setup adds posting times.</p>
          <button className="primary" onClick={() => setSetupOpen(true)}>
            Open Queue setup
          </button>
        </div>
      ) : null}
      <div className="queue-layout solo">
      <div>
      <div className="cal" style={{ marginBottom: 0 }}>
        {DAYS.map((d) => (
          <div key={d} className="cal-dow">{d}</div>
        ))}
      </div>
      <div className={view === "week" ? "cal" : "cal month"} style={{ marginTop: 0 }}>
        {days.map((day) => {
          const daySlots = byDay(day);
          const dayHistory = historyByDay(day);
          const shown = daySlots;
          const shownHistory = dayHistory;
          const now = new Date();
          const isToday =
            day.getFullYear() === now.getFullYear() &&
            day.getMonth() === now.getMonth() &&
            day.getDate() === now.getDate();
          const dim =
            view === "month" && day.getMonth() !== days[15].getMonth() ? " dim" : "";
          return (
            <div className={`day${dim}${isToday ? " today" : ""}`} key={day.toISOString()}>
              <div className="dayhead">
                {view === "week"
                  ? `${DAYS[day.getDay()]} ${day.getMonth() + 1}/${day.getDate()}`
                  : day.getDate()}
              </div>
              {shown.map((s) => (
                <button
                  key={s.id}
                  className={`slot st-${s.status}${selected?.id === s.id ? " sel" : ""}${draftingIds.has(s.id) ? " working" : ""}`}
                  onClick={() => void openSlot(s.id)}
                >
                  <span className={`dot d-${s.status}`} />
                  <span className="slottime">{fmtTime(s.scheduled_at)}</span>
                  <span className="slotmain">{typeLabel(s.content_type)}</span>
                  {view === "week" ? (
                    <span className="slotsub">
                      {draftingIds.has(s.id)
                        ? "Drafting…"
                        : `${s.pillar_name ?? "no pillar"}${s.draft_count > 0 ? ` · ${s.draft_count} draft${s.draft_count === 1 ? "" : "s"}` : ""}`}
                    </span>
                  ) : null}
                </button>
              ))}
              {dayHistory.length > 0 ? <div className="posted-label">Posted</div> : null}
              {shownHistory.map((a) => {
                const when = new Date(a.posted_at ?? a.created_at);
                const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                const label = `${SOURCE_SHORT[a.source] ?? a.source} ${time}: ${a.title}`;
                const inner = (
                  <>
                    <span className="asrc">{time}</span>
                    {SOURCE_SHORT[a.source] ?? "•"} · {a.title}
                  </>
                );
                return a.source_url ? (
                  <a
                    key={a.id}
                    className="asset-chip"
                    href={a.source_url}
                    target="_blank"
                    rel="noreferrer"
                    title={label}
                  >
                    {inner}
                  </a>
                ) : (
                  <span key={a.id} className="asset-chip" title={label}>
                    {inner}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>

      </div>
      {selected ? (
        <section className="keycard slot-inspector">
          <h2>
            {new Date(selected.scheduled_at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ·{" "}
            {typeLabel(selected.content_type)} · {fmtTime(selected.scheduled_at)}
            <span className={`status stext-${selected.status}`}>{selected.status}</span>
          </h2>
          <p className="muted">
            {selected.pillar_name ?? "no pillar"} ·{" "}
            {parsePlatforms(selected.platforms).join(", ") || "no platforms"}
          </p>
          <div className="row">
            {selected.status === "red" ? (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void runJob("/api/draft/run", { slotId: selected.id }, "Drafted")}
              >
                {draftingIds.has(selected.id) ? "Drafting…" : "Draft now"}
              </button>
            ) : null}
            {selected.status === "orange" ? (
              <button className="primary" onClick={() => void setStatus(selected.id, "green")}>
                Approve
              </button>
            ) : null}
            {selected.status === "green" &&
            !publishHistory.some((h) => IN_FLIGHT.has(h.status)) ? (
              <button
                className="primary"
                disabled={publishing}
                onClick={() => void publishNow(selected.id)}
              >
                {(() => {
                  const future = Date.parse(selected.scheduled_at) > Date.now();
                  if (publishing) return future ? "Scheduling…" : "Posting…";
                  return future
                    ? `Schedule for ${fmtTime(selected.scheduled_at)}`
                    : "Post now";
                })()}
              </button>
            ) : null}
            {selected.status === "green" &&
            publishHistory.some((h) => IN_FLIGHT.has(h.status)) ? (
              <button disabled={publishing} onClick={() => void cancelScheduled(selected.id)}>
                Cancel scheduled
              </button>
            ) : null}
            {selected.status === "green" ? (
              <button onClick={() => void markPosted(selected.id)} title="Posted it outside Creagent — just mark the slot done">
                Mark posted
              </button>
            ) : null}
            {selected.status === "green" ? (
              <button onClick={() => void reopenSlot(selected.id)} title="Send back to review to edit the draft">
                Reopen
              </button>
            ) : null}
            {isVideoType(selected.content_type) ? (
              <button onClick={() => void openVideo(selected)}>Video editor</button>
            ) : null}
            {isVideoType(selected.content_type) &&
            attachments.some((a) => a.kind === "video") ? (
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void runJob(`/api/slots/${selected.id}/auto-edit`, {}, "Cut ready for review")
                }
              >
                Auto-edit footage
              </button>
            ) : null}
            {selected.content_type === "carousel" ? (
              <button onClick={() => void openCarousel(selected)}>Carousel</button>
            ) : null}
            {selected.content_type === "carousel" && selected.approved_draft_id ? (
              <button
                className="primary"
                disabled={busy}
                onClick={() => void imageDraft(selected)}
                title="Build slides from the approved copy and match library photos"
              >
                Image draft
              </button>
            ) : null}
            <button onClick={() => void removeSlot(selected.id)}>Delete</button>
            <button onClick={() => setSelected(null)}>Close</button>
          </div>
          {draftingIds.has(selected.id) ? (
            <p className="note">Drafting this slot — options appear below when done.</p>
          ) : null}
          {publishing ? (
            <p className="note">Posting via Zernio — receipts appear below.</p>
          ) : null}
          {publishResult && !publishResult.ok ? (
            <p className="note err">{publishResult.error ?? "Posting failed."}</p>
          ) : null}
          {publishResult?.receipts && publishResult.receipts.length > 0 ? (
            <div className="pub-receipts">
              {publishResult.receipts.map((r) => (
                <div key={r.platform} className="pub-receipt">
                  <span className="pub-plat">{r.platform}</span>
                  {r.username ? <span className="muted"> @{r.username}</span> : null}
                  <span className="muted"> · {r.payload}</span>
                  {r.status === "published" && r.postUrl ? (
                    <a href={r.postUrl} target="_blank" rel="noreferrer"> · view ✓</a>
                  ) : IN_FLIGHT.has(r.status) ? (
                    <span> · scheduled ✓</span>
                  ) : (
                    <span> · {r.error ?? r.status}</span>
                  )}
                </div>
              ))}
            </div>
          ) : null}
          {selected.status === "green" &&
          publishHistory.some((h) => IN_FLIGHT.has(h.status)) ? (
            <p className="note ok">
              Scheduled for {fmtTime(selected.scheduled_at)} ✓ — goes live on its own, or Cancel
              scheduled above to change it.
            </p>
          ) : null}
          {selected.status === "gray" &&
          publishHistory.some((h) => h.status === "published") ? (
            <div className="pub-receipts">
              <p className="dr-sub">Posted via Zernio</p>
              {publishHistory
                .filter((h) => h.status === "published")
                .map((h) => (
                  <div key={`${h.attempt}-${h.platform}`} className="pub-receipt">
                    <span className="pub-plat">{h.platform}</span>
                    {h.username ? <span className="muted"> @{h.username}</span> : null}
                    <span className="muted"> · {h.payload}</span>
                    {h.postUrl ? (
                      <a href={h.postUrl} target="_blank" rel="noreferrer"> · view ✓</a>
                    ) : null}
                  </div>
                ))}
            </div>
          ) : null}
          {(() => {
            if (selected.status !== "green" && selected.status !== "gray") return null;
            const versions = selected.drafts ?? [];
            if (versions.length === 0) return null;
            const pinned =
              versions.find((dd) => dd.id === selected.approved_draft_id) ??
              versions[versions.length - 1];
            const heroIdx =
              pinned.id === selected.approved_draft_id
                ? clampSelection(String(selected.approved_option ?? 0), optionCountOf(pinned))
                : clampSelection(pinned.selection, optionCountOf(pinned));
            const hero = approvedBody(pinned, heroIdx);
            const vnum = versions.length > 1 ? `Draft ${versions.indexOf(pinned) + 1} · ` : "";
            const heroThread = isThreadKind(selected.content_type);
            const heroParas = hero.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
            const heroN = heroThread ? longestParagraph(hero) : charCount(hero);
            const heroCap = slotCap(selected.platforms);
            const overCaps = parsePlatforms(selected.platforms).filter((p) => {
              const cap = PLATFORM_POST_CAPS[p];
              if (cap === undefined) return false;
              return heroThread
                ? heroParas.some((para) => charCount(para) > cap)
                : heroN > cap;
            });
            return (
              <div className="aphero">
                <p className="dr-sub">
                  {selected.status === "gray" ? "Posted" : "Approved post"} · {vnum}Option {heroIdx + 1} ·{" "}
                  {heroThread ? "longest " : ""}
                  {heroN}
                  {heroCap !== null ? `/${heroCap}` : ""}
                  {heroThread ? "" : " chars"}
                  {overCaps.length > 0 ? (
                    <span className="overcap">
                      {" "}
                      · over {PLAT_LABEL[overCaps[0] ?? ""] ?? overCaps[0]}
                      {overCaps.length > 1 ? ` (+${overCaps.length - 1} more)` : ""}
                    </span>
                  ) : null}
                </p>
                <div className="dr-prose">
                  <p>{hero}</p>
                </div>
                <div className="row">
                  <button onClick={() => void copyPost(hero)}>{copied ? "Copied ✓" : "Copy post"}</button>
                </div>
              </div>
            );
          })()}
          {(selected.drafts ?? []).length > 0 ? (
            <div className="row">
              <button onClick={() => setVersionsOpen((v) => !(v ?? !isDone(selected.status)))}>
                {(versionsOpen ?? !isDone(selected.status)) ? "▾" : "▸"} Versions ({(selected.drafts ?? []).length})
              </button>
            </div>
          ) : null}
          {(versionsOpen ?? !isDone(selected.status))
            ? (selected.drafts ?? []).map((d, i) => {
            const structure = parseStructure(d.structure);
            const optionCount = optionCountOf(d);
            const picked = clampSelection(d.selection, optionCount);
            const layout = structure?.layout ?? (optionCount > 1 ? "pick-one" : "prose");
            const versionCount = (selected.drafts ?? []).length;
            const title =
              versionCount > 1
                ? `Draft ${i + 1} (${typeLabel(d.kind)})`
                : `Draft (${typeLabel(d.kind)})`;
            const nextStepBase =
              layout === "pick-one"
                ? "Pick the post to run with — then Approve above."
                : layout === "hooks-plus-body"
                  ? "Pick a hook — it tops the thread below. Then Approve above."
                  : "Review — then Approve above, or Edit / Feedback to revise.";
            const nextStep =
              parsePlatforms(selected.platforms).includes("x") &&
              (d.kind === "short_post" || isThreadKind(d.kind))
                ? `${nextStepBase} Reply to early comments — the algorithm's top signal.`
                : nextStepBase;
            return (
            <div key={d.id}>
              <DraftReview
                draftId={d.id}
                title={title}
                edited={d.status === "edited"}
                structure={structure}
                body={d.body}
                selection={picked}
                nextStep={nextStep}
                limit={slotCap(selected.platforms)}
                onSelect={(idx) => void selectOption(d.id, idx)}
                onEdit={(target) => {
                  if (target === null || !structure) {
                    setEditing({ id: d.id, body: d.body, target: null, title: "Edit draft" });
                  } else if (target === "thread") {
                    setEditing({
                      id: d.id,
                      body: structure.body ?? d.body,
                      target: "thread",
                      title: "Edit thread",
                    });
                  } else {
                    const opt = structure.options[target];
                    if (!opt) {
                      setEditing({ id: d.id, body: d.body, target: null, title: "Edit draft" });
                    } else {
                      setEditing({
                        id: d.id,
                        body: opt.body,
                        target,
                        title: `Edit option — ${opt.label}`,
                      });
                    }
                  }
                }}
                onFeedback={() => setFeedback({ draftId: d.id, body: "", standing: false })}
              />
              {feedback && feedback.draftId === d.id ? (
                <div className="feedback-form">
                  <textarea
                    value={feedback.body}
                    onChange={(e) =>
                      setFeedback({ draftId: d.id, body: e.target.value, standing: feedback.standing })
                    }
                    placeholder="What should change? e.g. more specific facts, no nationalism framing…"
                  />
                  <label className="checkline">
                    <input
                      type="checkbox"
                      checked={feedback.standing}
                      onChange={(e) =>
                        setFeedback({ draftId: d.id, body: feedback.body, standing: e.target.checked })
                      }
                    />
                    Save as standing rule for all future drafts
                  </label>
                  <div className="row">
                    <button
                      className="primary"
                      disabled={busy || feedback.body.trim().length === 0}
                      onClick={() => void sendFeedback(selected.id, "refine")}
                    >
                      {busy ? "Working…" : "Refine picked"}
                    </button>
                    <button
                      disabled={busy || feedback.body.trim().length === 0}
                      onClick={() => void sendFeedback(selected.id, "set")}
                    >
                      {busy ? "Working…" : "New set"}
                    </button>
                    <button disabled={busy} onClick={() => setFeedback(null)}>
                      Cancel
                    </button>
                  </div>
                  {busy && feedbackStatus ? <p className="note">{feedbackStatus}</p> : null}
                </div>
              ) : null}
            </div>
            );
          })
            : null}
          {genRequests.length > 0 ? (
            <>
              <h2>Image requests ({genRequests.filter((r) => r.status === "pending").length} pending)</h2>
              {genRequests.map((r) => (
                <div key={r.id}>
                  <p className={r.status === "pending" ? "note" : "muted"}>
                    [{r.status}] {r.prompt}
                  </p>
                  {r.status === "pending" ? (
                    <div className="row">
                      <button
                        className="primary"
                        onClick={() => void decideRequest(selected.id, r.id, "approve")}
                      >
                        Approve + generate
                      </button>
                      <button onClick={() => void decideRequest(selected.id, r.id, "reject")}>
                        Reject
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </>
          ) : null}
          <h2>Files ({attachments.length})</h2>
          <p className="muted">
            Raw footage and finished files. On video slots, attached footage
            feeds Auto-edit; finished edits attach here for posting.
          </p>
          {attachments.map((a) => (
            <p key={a.id}>
              <a href={`/api/attachments/${a.id}/file`} target="_blank" rel="noreferrer">
                {a.filename}
              </a>{" "}
              <span className="muted">
                ({a.kind}, {(a.size / 1024).toFixed(0)} KB)
              </span>{" "}
              <button onClick={() => void removeAttachment(selected.id, a.id)}>Delete</button>
            </p>
          ))}
          <div className="row">
            <input
              type="file"
              aria-label="Upload a finished file"
              onChange={(e) => {
                void uploadFile(selected.id, e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
          {editing ? (
            <div className="overlay" role="dialog" aria-label="Edit draft">
              <div className="dialog">
                <h2>{editing.title}</h2>
                <textarea
                  rows={14}
                  value={editing.body}
                  onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                />
                {(() => {
                  const thread = isThreadKind(selected.content_type);
                  const n = thread ? longestParagraph(editing.body) : charCount(editing.body);
                  const cap = slotCap(selected.platforms);
                  const over = cap !== null && n > cap;
                  return (
                    <p className={over ? "overcap" : "muted"}>
                      {thread ? "longest post " : ""}
                      {n}
                      {cap !== null ? `/${cap}` : ""}
                      {thread ? "" : " chars"}
                      {over ? " — over the limit" : ""}
                    </p>
                  );
                })()}
                <div className="row">
                  <button className="primary" onClick={() => void saveEdit()}>
                    Save
                  </button>
                  <button onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      </div>
      {setupOpen
        ? createPortal(
            <div className="modal-backdrop" onClick={() => setSetupOpen(false)}>
          <div className="modal wide" role="dialog" aria-label="Queue setup" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head">
            <h2>Queue setup</h2>
            <button onClick={() => setSetupOpen(false)} aria-label="Close">
              ×
            </button>
          </div>
          <p className="muted">
            Each row ships one post to every checked platform. ⚠ marks
            pillar×platform combos under 0.7x.
          </p>
          <section className="keycard slim">
            <div className="row">
              <textarea
                ref={agentBoxRef}
                rows={2}
                aria-label="Describe your cadence to the agent"
                placeholder='e.g. "Post every day at 9am and 2pm, threads on X in the morning"'
                value={agentInput}
                onChange={(e) => {
                  setAgentInput(e.target.value);
                  const el = agentBoxRef.current;
                  if (el) {
                    el.style.height = "auto";
                    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void askAgent();
                  }
                }}
              />
              <button className="primary" disabled={agentBusy || !agentInput.trim()} onClick={() => void askAgent()}>
                {agentBusy ? "Working…" : "Ask agent"}
              </button>
            </div>
            {agentBusy ? <p className="muted">The agent is setting up your queue…</p> : null}
            {agentNote ? <p className="note ok">{agentNote}</p> : null}
          </section>
          {(() => {
            const known = new Set<string>([...PLATFORMS]);
            const groups = new Map<string, Template[]>();
            for (const t of templates) {
              const key = `${t.time}|${t.pillar_id ?? ""}|${t.content_type}|${parsePlatforms(t.platforms).slice().sort().join(",")}`;
              const g = groups.get(key) ?? [];
              g.push(t);
              groups.set(key, g);
            }
            const daily: Template[][] = [];
            const byDay: Template[][] = [[], [], [], [], [], [], []];
            for (const g of groups.values()) {
              if (new Set(g.map((t) => t.weekday)).size === 7) daily.push(g);
              else for (const t of g) (byDay[t.weekday] ?? byDay[0]).push(t);
            }
            daily.sort((a, b) => (a[0]?.time ?? "").localeCompare(b[0]?.time ?? ""));
            for (const list of byDay) list.sort((a, b) => a.time.localeCompare(b.time));
            const togglePlat = (t: Template, ids: string[], pl: string): void => {
              const cur = parsePlatforms(t.platforms);
              const next = cur.includes(pl) ? cur.filter((p) => p !== pl) : [...cur, pl];
              void setTemplatePlatforms(ids, next);
            };
            const card = (
              key: string,
              labelText: string,
              t: Template,
              ids: string[],
              onDelete: () => void,
              deleteLabel: string,
            ): React.ReactNode => {
              const plats = parsePlatforms(t.platforms);
              const unknowns = plats.filter((p) => !known.has(p));
              const pillarName = pillars.find((p) => p.id === t.pillar_id)?.name ?? "This pillar";
              const warns = plats
                .map((p) => ({ platform: p, st: fitStat(pillars, t.pillar_id, p) }))
                .filter((w) => isWeakStat(w.st) && w.st && w.st.multiplier !== null);
              return (
                <section className="keycard slim" key={key}>
                  <p>
                    <strong>{labelText}</strong> · {typeLabel(t.content_type)}
                  </p>
                  <div className="ppills compact" role="group" aria-label="Platforms for this time">
                    {PLATFORMS.map((pl) => (
                      <button
                        key={pl}
                        className={plats.includes(pl) ? "on" : ""}
                        aria-pressed={plats.includes(pl)}
                        onClick={() => togglePlat(t, ids, pl)}
                      >
                        {PLAT_LABEL[pl] ?? pl}
                      </button>
                    ))}
                  </div>
                  {unknowns.length > 0 ? (
                    <p className="muted">Also ships to: {unknowns.join(", ")}</p>
                  ) : null}
                  {plats.length === 0 ? (
                    <p className="note warn">No platforms — check at least one or this row never ships.</p>
                  ) : null}
                  {warns.map((w) => (
                    <p className="note warn" key={w.platform}>
                      ⚠ {pillarName} scores {w.st?.multiplier}x on {PLAT_LABEL[w.platform] ?? w.platform} across{" "}
                      {w.st?.posts} posts
                    </p>
                  ))}
                  <div className="row">
                    <select
                      aria-label="Pillar"
                      value={t.pillar_id ?? ""}
                      onChange={(e) => void setTemplatePillar(ids, e.target.value)}
                    >
                      <option value="">No pillar</option>
                      {pillars.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <button className="danger" onClick={() => void onDelete()}>
                      {deleteLabel}
                    </button>
                  </div>
                </section>
              );
            };
            const draftWarns = draft.platforms
              .map((p) => ({ platform: p, st: fitStat(pillars, draft.pillar_id || null, p) }))
              .filter((w) => isWeakStat(w.st) && w.st && w.st.multiplier !== null);
            const draftPillar = pillars.find((p) => p.id === draft.pillar_id)?.name ?? "This pillar";
            return (
              <>
                {daily.length > 0 ? (
                  <section className="keycard" key="daily">
                    <h2>Every day</h2>
                    {daily.map((g) => {
                      const first = g[0];
                      if (!first) return null;
                      const ids = g.map((t) => t.id);
                      return card(
                        `daily-${first.id}`,
                        first.time,
                        first,
                        ids,
                        () => removeDaily(ids),
                        "Delete all 7",
                      );
                    })}
                  </section>
                ) : null}
                {DAY_FULL.map((day, i) =>
                  byDay[i].length > 0 ? (
                    <section className="keycard" key={day}>
                      <h2>
                        {day} ({byDay[i].length})
                      </h2>
                      {byDay[i].map((t) =>
                        card(`${t.id}`, t.time, t, [t.id], () => removeTemplate(t.id), "Delete"),
                      )}
                    </section>
                  ) : null,
                )}
                {templates.length === 0 ? (
                  <p className="muted">No posting times yet — add one below or ask the agent.</p>
                ) : null}
                {adding ? (
                  <section className="keycard" key="add">
                    <h2>New posting time</h2>
                    <div className="tform-grid">
                      <label>
                        Day
                        <select
                          value={draft.weekday}
                          onChange={(e) => setDraft((f) => ({ ...f, weekday: e.target.value }))}
                        >
                          <option value="all">Every day</option>
                          {DAYS.map((d, i) => (
                            <option key={d} value={String(i)}>
                              {d}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Time
                        <select
                          value={draft.time}
                          onChange={(e) => setDraft((f) => ({ ...f, time: e.target.value }))}
                        >
                          {QUARTERS.map((q) => (
                            <option key={q} value={q}>
                              {q}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Pillar
                        <select
                          value={draft.pillar_id}
                          onChange={(e) => setDraft((f) => ({ ...f, pillar_id: e.target.value }))}
                        >
                          <option value="">No pillar</option>
                          {pillars.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Post type
                        <select
                          value={draft.content_type}
                          onChange={(e) => setDraft((f) => ({ ...f, content_type: e.target.value }))}
                        >
                          {Object.entries(CONTENT_TYPES).map(([id, t]) => (
                            <option key={id} value={id}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <p className="dr-sub">Platforms</p>
                    <div className="ppills compact" role="group" aria-label="Platforms for this time">
                      {PLATFORMS.map((pl) => (
                        <button
                          key={pl}
                          className={draft.platforms.includes(pl) ? "on" : ""}
                          aria-pressed={draft.platforms.includes(pl)}
                          onClick={() =>
                            setDraft((f) => ({
                              ...f,
                              platforms: f.platforms.includes(pl)
                                ? f.platforms.filter((p) => p !== pl)
                                : [...f.platforms, pl],
                            }))
                          }
                        >
                          {PLAT_LABEL[pl] ?? pl}
                        </button>
                      ))}
                    </div>
                    {draftWarns.map((w) => (
                      <p className="note warn" key={w.platform}>
                        ⚠ {draftPillar} scores {w.st?.multiplier}x on {PLAT_LABEL[w.platform] ?? w.platform} across{" "}
                        {w.st?.posts} posts — save anyway to push into it deliberately.
                      </p>
                    ))}
                    <div className="row">
                      <button className="primary" onClick={() => void addTemplate()}>
                        Save
                      </button>
                      <button onClick={() => setAdding(false)}>Cancel</button>
                    </div>
                  </section>
                ) : (
                  <div className="row">
                    <button
                      onClick={() => {
                        setDraft({
                          weekday: "1",
                          time: "09:00",
                          pillar_id: "",
                          content_type: "short_post",
                          platforms: [],
                        });
                        setAdding(true);
                      }}
                    >
                      + Add posting time
                    </button>
                  </div>
                )}
              </>
            );
          })()}
            </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
