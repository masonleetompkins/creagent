"use client";

import { useCallback, useEffect, useState } from "react";
import { CONTENT_TYPES } from "@/lib/content";

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

async function pollJob(jobId: string): Promise<Record<string, unknown>> {
  for (;;) {
    const data = await readJson(await fetch(`/api/jobs/${jobId}`));
    if (data.state === "completed" || data.state === "failed") return data;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
      const [slotData, tmplData, pillarData, assetData] = await Promise.all([
        readJson(await fetch(`/api/slots?${range}`)),
        readJson(await fetch("/api/templates")),
        readJson(await fetch("/api/pillars")),
        readJson(await fetch(`/api/assets?${range}&limit=500`)),
      ]);
      setSlots(slotData.slots as Slot[]);
      setTemplates(tmplData.templates as Template[]);
      setPillars((pillarData.pillars as Pillar[]) ?? []);
      setHistory((assetData.assets as HistoryAsset[]) ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [weekStart, monthGridStart, view]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      const done = await pollJob(started.jobId as string);
      if (done.state === "failed") throw new Error((done.failedReason as string) ?? "job failed");
      setNote(`${label}: ${JSON.stringify(done.result ?? {}).slice(0, 200)}`);
      await refresh();
      setSelected(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
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
    try {
      await readJson(
        await fetch("/api/templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            weekday: Number(form.weekday),
            time: form.time,
            pillar_id: form.pillar_id || null,
            content_type: form.content_type,
            platforms: form.platforms.split(",").map((p) => p.trim().toLowerCase()),
          }),
        }),
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
      <section className="keycard">
        <div className="row">
          <button disabled={busy} onClick={() => void runJob("/api/plan/run", { days: 14 }, "Planned")}>
            Plan 14 days
          </button>
          <button disabled={busy} onClick={() => void runJob("/api/draft/run", { limit: 10 }, "Drafted")}>
            Draft all red
          </button>
          <button
            disabled={busy}
            onClick={() => setSetupOpen((o) => !o)}
            className={setupOpen || templates.length === 0 ? "primary" : ""}
          >
            Queue setup
          </button>
          <button disabled={busy} onClick={() => setView("week")} className={view === "week" ? "primary" : ""}>
            Week
          </button>
          <button disabled={busy} onClick={() => setView("month")} className={view === "month" ? "primary" : ""}>
            Month
          </button>
          <button disabled={busy} onClick={goPrev}>
            ← Prev
          </button>
          <button disabled={busy} onClick={goToday}>
            Today
          </button>
          <button disabled={busy} onClick={goNext}>
            Next →
          </button>
          {view === "month" ? <span className="muted">{monthLabel}</span> : null}
        </div>
        {busy ? <p className="muted">Working…</p> : null}
        {note ? <p className="note ok">{note}</p> : null}
        {error ? <p className="note err">{error}</p> : null}
      </section>

      <div className={view === "week" ? "cal" : "cal month"}>
        {days.map((day) => {
          const daySlots = byDay(day);
          const dayHistory = historyByDay(day);
          const shown = view === "week" ? daySlots : daySlots.slice(0, 3);
          const shownHistory = view === "week" ? dayHistory : dayHistory.slice(0, 2);
          const dim =
            view === "month" && day.getMonth() !== days[15].getMonth() ? " dim" : "";
          return (
            <div className={`day${dim}`} key={day.toISOString()}>
              <div className="dayhead">
                {view === "week"
                  ? `${DAYS[day.getDay()]} ${day.getMonth() + 1}/${day.getDate()}`
                  : day.getDate()}
              </div>
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
              {view === "month" && dayHistory.length > 2 ? (
                <span className="muted">+{dayHistory.length - 2} posted</span>
              ) : null}
              {shown.map((s) => (
                <button
                  key={s.id}
                  className={`slot st-${s.status}`}
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
              {view === "month" && daySlots.length > 3 ? (
                <span className="muted">+{daySlots.length - 3} more</span>
              ) : null}
            </div>
          );
        })}
      </div>

      {selected ? (
        <section className="keycard">
          <h2>
            {typeLabel(selected.content_type)} · {fmtTime(selected.scheduled_at)}
            <span className={`status stext-${selected.status}`}>{selected.status}</span>
          </h2>
          <p className="muted">
            {selected.pillar_name ?? "no pillar"} ·{" "}
            {(JSON.parse(selected.platforms || "[]") as string[]).join(", ") || "no platforms"}
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

      {setupOpen || templates.length === 0 ? (
        <>
          <h2>Queue setup</h2>
          <p className="muted">
            Posting times per day, with a pillar, content type, and platforms
            for each. The planner materializes these into calendar slots.
          </p>
          {templates.map((t) => (
        <section className="keycard" key={t.id}>
          <p>
            <strong>
              {DAYS[t.weekday]} {t.time}
            </strong>{" "}
            · {typeLabel(t.content_type)} · {t.pillar_name ?? "no pillar"} ·{" "}
            {(JSON.parse(t.platforms || "[]") as string[]).join(", ") || "no platforms"}
          </p>
          <div className="row">
            <button onClick={() => void removeTemplate(t.id)}>Delete</button>
          </div>
        </section>
      ))}
      <section className="keycard">
        <h2>Add a template</h2>
        <div className="row">
          <select
            aria-label="Weekday"
            value={form.weekday}
            onChange={(e) => setForm((f) => ({ ...f, weekday: e.target.value }))}
          >
            {DAYS.map((d, i) => (
              <option key={d} value={String(i)}>
                {d}
              </option>
            ))}
          </select>
          <input
            type="text"
            aria-label="Time HH:MM"
            placeholder="09:00"
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
          <input
            type="text"
            aria-label="Platforms"
            placeholder="x, threads"
            value={form.platforms}
            onChange={(e) => setForm((f) => ({ ...f, platforms: e.target.value }))}
          />
          <button onClick={() => void addTemplate()}>Add</button>
        </div>
      </section>
        </>
      ) : null}
    </>
  );
}
