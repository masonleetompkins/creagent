"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CONTENT_TYPES, PLATFORMS } from "@/lib/content";

type Slot = {
  id: string;
  scheduled_at: string;
  pillar_id: string | null;
  pillar_name: string | null;
  content_type: string;
  platforms: string;
  status: string;
  draft_count: number;
};

type Draft = {
  id: string;
  kind: string;
  body: string;
  status: string;
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

type Pillar = { id: string; name: string };

type HistoryAsset = {
  id: string;
  source: string;
  title: string;
  source_url: string | null;
  posted_at: string | null;
  created_at: string;
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [agentInput, setAgentInput] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentNote, setAgentNote] = useState<string | null>(null);
  const [anyRed, setAnyRed] = useState(true);
  const [jobProgress, setJobProgress] = useState<{ done: number; total: number } | null>(null);
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
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [form, setForm] = useState({
    weekday: "1",
    time: "09:00",
    pillar_id: "",
    content_type: "short_post",
    platforms: "x",
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
      const [slotData, tmplData, pillarData, assetData, horizonData] = await Promise.all([
        readJson(await fetch(`/api/slots?${range}`)),
        readJson(await fetch("/api/templates")),
        readJson(await fetch("/api/pillars")),
        readJson(await fetch(`/api/assets?${range}&limit=500`)),
        readJson(await fetch(`/api/slots?${horizonRange}`)),
      ]);
      setSlots(slotData.slots as Slot[]);
      setAnyRed(((horizonData.slots as Slot[]) ?? []).some((sl) => sl.status === "red"));
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
      setSelected(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setJobProgress(null);
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
    try {
      const [data, files, reqs] = await Promise.all([
        readJson(await fetch(`/api/slots/${id}/drafts`)),
        readJson(await fetch(`/api/slots/${id}/attachments`)),
        readJson(await fetch(`/api/slots/${id}/gen-requests`)),
      ]);
      setSelected({ ...((data.slot as Slot) ?? {}), drafts: (data.drafts as Draft[]) ?? [] } as Slot & {
        drafts: Draft[];
      });
      setAttachments((files.attachments as Attachment[]) ?? []);
      setGenRequests((reqs.requests as GenRequest[]) ?? []);
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
    try {
      await readJson(await fetch(`/api/slots/${id}/post`, { method: "POST" }));
      await refresh();
      await openSlot(id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveEdit(): Promise<void> {
    if (!editing || !selected) return;
    try {
      await readJson(
        await fetch(`/api/drafts/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: editing.body }),
        }),
      );
      setEditing(null);
      await openSlot(selected.id);
    } catch (e) {
      setError((e as Error).message);
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

  async function openCarousel(slot: Slot): Promise<void> {
    try {
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
      form.weekday === "all" ? [0, 1, 2, 3, 4, 5, 6] : [Number(form.weekday)];
    const plats = form.platforms.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
    let created = 0;
    let skipped = 0;
    try {
      for (const weekday of days) {
        if (templates.some(
          (t) =>
            t.weekday === weekday &&
            t.time === form.time &&
            (t.pillar_id ?? "") === (form.pillar_id || "") &&
            t.content_type === form.content_type &&
            JSON.stringify(parsePlatforms(t.platforms).slice().sort()) === JSON.stringify(plats.slice().sort()),
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
              time: form.time,
              pillar_id: form.pillar_id || null,
              content_type: form.content_type,
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
            message: `Set up my posting queue as follows: ${text}\n\nRules: weekdays are 0=Sunday..6=Saturday. First call list_templates to see the current schedule and list_pillars for pillar names. Use add_template for each slot (everyday=true for daily cadences) and delete_template to remove ones I no longer want. Always assign every slot the best-fit confirmed pillar, even when I don't name one — never leave pillar blank unless I have no confirmed pillars. When the templates are right, call run_planner once to materialize slots, then reply with a short summary of the schedule including which pillar each slot uses.`,
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
          onClick={() => setSetupOpen(true)}
          className={setupOpen ? "primary" : ""}
        >
          Queue setup
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
      <div className={selected ? "queue-layout" : "queue-layout solo"}>
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
          const expanded = expandedDay === day.toISOString();
          const slotCap = expanded ? 99 : view === "week" ? 4 : 3;
          const histCap = expanded ? 99 : view === "week" ? 3 : 2;
          const shown = daySlots.slice(0, slotCap);
          const shownHistory = dayHistory.slice(0, histCap);
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
                  className={`slot st-${s.status}${selected?.id === s.id ? " sel" : ""}`}
                  onClick={() => void openSlot(s.id)}
                >
                  <span className={`dot d-${s.status}`} />
                  <span className="slottime">{fmtTime(s.scheduled_at)}</span>
                  <span className="slotmain">{typeLabel(s.content_type)}</span>
                  {view === "week" ? (
                    <span className="slotsub">
                      {s.pillar_name ?? "no pillar"}
                      {s.draft_count > 0 ? ` · ${s.draft_count} draft${s.draft_count === 1 ? "" : "s"}` : ""}
                    </span>
                  ) : null}
                </button>
              ))}
              {shown.length < daySlots.length ? (
                <button className="chip-more" onClick={() => setExpandedDay(day.toISOString())}>
                  +{daySlots.length - shown.length} slots
                </button>
              ) : null}
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
              {shownHistory.length < dayHistory.length ? (
                <button className="chip-more" onClick={() => setExpandedDay(day.toISOString())}>
                  +{dayHistory.length - shownHistory.length} posted
                </button>
              ) : null}
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
                Draft now
              </button>
            ) : null}
            {selected.status === "orange" ? (
              <button className="primary" onClick={() => void setStatus(selected.id, "green")}>
                Approve
              </button>
            ) : null}
            {selected.status === "green" ? (
              <button className="primary" onClick={() => void markPosted(selected.id)}>
                Mark posted
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
            <button onClick={() => void removeSlot(selected.id)}>Delete</button>
            <button onClick={() => setSelected(null)}>Close</button>
          </div>
          {(selected.drafts ?? []).map((d) => (
            <div key={d.id}>
              <h2>
                Draft ({typeLabel(d.kind)}){d.status === "edited" ? " — edited" : ""}
              </h2>
              <p className="draftbody">{d.body}</p>
              <div className="row">
                <button onClick={() => setEditing({ id: d.id, body: d.body })}>Edit</button>
              </div>
            </div>
          ))}
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
                <h2>Edit draft</h2>
                <textarea
                  rows={14}
                  value={editing.body}
                  onChange={(e) => setEditing({ id: editing.id, body: e.target.value })}
                />
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
      {setupOpen ? (
        <div className="modal-backdrop" onClick={() => setSetupOpen(false)}>
          <div className="modal" role="dialog" aria-label="Queue setup" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head">
            <h2>Queue setup</h2>
            <button onClick={() => setSetupOpen(false)} aria-label="Close">
              ×
            </button>
          </div>
          <p className="muted">
            Posting times per day, with a pillar, content type, and platforms
            for each. The planner materializes these into calendar slots.
          </p>
          <section className="keycard slim">
            <div className="row">
              <input
                type="text"
                aria-label="Describe your cadence to the agent"
                placeholder='e.g. "Post every day at 9am and 2pm, threads on X in the morning"'
                value={agentInput}
                onChange={(e) => setAgentInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void askAgent();
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
        const groups = new Map<string, typeof templates>();
        for (const t of templates) {
          const key = `${t.time}|${t.pillar_id ?? ""}|${t.content_type}|${parsePlatforms(t.platforms).slice().sort().join(",")}`;
          const g = groups.get(key) ?? [];
          g.push(t);
          groups.set(key, g);
        }
        const rows: React.ReactNode[] = [];
        const card = (
          key: string,
          label: string,
          t: { content_type: string; pillar_id: string | null; platforms: string },
          ids: string[],
          onDelete: () => void,
          deleteLabel: string,
        ): React.ReactNode => (
          <section className="keycard" key={key}>
            <p>
              <strong>{label}</strong> · {typeLabel(t.content_type)} ·{" "}
              {parsePlatforms(t.platforms).join(", ") || "no platforms"}
            </p>
            <div className="row">
              <select
                aria-label="Pillar"
                value={t.pillar_id ?? ""}
                onChange={(e) => void setTemplatePillar(ids, e.target.value)}
              >
                <option value="">No pillar</option>
                {pillars.map((pl) => (
                  <option key={pl.id} value={pl.id}>
                    {pl.name}
                  </option>
                ))}
              </select>
              <button className="danger" onClick={() => void onDelete()}>
                {deleteLabel}
              </button>
            </div>
          </section>
        );
        for (const g of [...groups.values()].sort((a, b) => (a[0]?.time ?? "").localeCompare(b[0]?.time ?? ""))) {
          const first = g[0];
          if (!first) continue;
          if (new Set(g.map((t) => t.weekday)).size === 7) {
            rows.push(
              card(
                `daily-${first.id}`,
                `Every day ${first.time}`,
                first,
                g.map((t) => t.id),
                () => removeDaily(g.map((t) => t.id)),
                "Delete all 7",
              ),
            );
          } else {
            for (const t of g.slice().sort((a, b) => a.weekday - b.weekday)) {
              rows.push(card(t.id, `${DAYS[t.weekday]} ${t.time}`, t, [t.id], () => removeTemplate(t.id), "Delete"));
            }
          }
        }
        return rows;
      })()}
      <section className="keycard">
        <h2>Add a template</h2>
        <div className="row">
          <select
            aria-label="Weekday"
            value={form.weekday}
            onChange={(e) => setForm((f) => ({ ...f, weekday: e.target.value }))}
          >
            <option value="all">Every day</option>
            {DAYS.map((d, i) => (
              <option key={d} value={String(i)}>
                {d}
              </option>
            ))}
          </select>
          <input
            type="time"
            aria-label="Posting time"
            value={form.time}
            onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}
          />
          <select
            aria-label="Pillar"
            value={form.pillar_id}
            onChange={(e) => setForm((f) => ({ ...f, pillar_id: e.target.value }))}
          >
            <option value="">No pillar</option>
            {pillars.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Content type"
            value={form.content_type}
            onChange={(e) => setForm((f) => ({ ...f, content_type: e.target.value }))}
          >
            {Object.entries(CONTENT_TYPES).map(([id, t]) => (
              <option key={id} value={id}>
                {t.label}
              </option>
            ))}
          </select>
          <div className="ppills" role="group" aria-label="Platforms">
            {PLATFORMS.map((pl) => {
              const on = form.platforms.split(",").map((x) => x.trim()).includes(pl);
              return (
                <button
                  key={pl}
                  className={on ? "on" : ""}
                  onClick={(e) => {
                    e.preventDefault();
                    const cur = form.platforms.split(",").map((x) => x.trim()).filter(Boolean);
                    const next = on ? cur.filter((x) => x !== pl) : [...cur, pl];
                    setForm((f) => ({ ...f, platforms: next.join(",") }));
                  }}
                >
                  {pl}
                </button>
              );
            })}
            <button className="on solid" onClick={() => void addTemplate()}>
              + Add
            </button>
          </div>
        </div>
      </section>
          </div>
        </div>
      ) : null}
    </>
  );
}
