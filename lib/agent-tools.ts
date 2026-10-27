// Agent tool registry: every action the chat agent can take, wrapping the
// same libs the UI routes use. Reads run inline; slow work enqueues worker
// jobs and returns jobIds. Spends and publishes stay user-only by design:
// image generation goes through approval-gated gen-requests, and only the
// user marks slots Posted (gray).
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";
import { enqueue, getJob } from "./queue";
import { brainOverview } from "./brain";
import { isContentType, PLATFORMS } from "./content";
import { searchVault } from "./vault";
import { isIngestSource } from "./ingest";

export type ToolResult = { ok: boolean; data?: unknown; error?: string };

export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<ToolResult>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${name} is required`);
  return v.trim();
}

function uuid(v: unknown, name: string): string {
  const s = str(v, name);
  if (!UUID_RE.test(s)) throw new Error(`${name} must be a UUID`);
  return s;
}

function num(v: unknown, name: string, def?: number): number {
  if (v === undefined || v === null) {
    if (def !== undefined) return def;
    throw new Error(`${name} is required`);
  }
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return v;
}

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(error: unknown): ToolResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

async function safe(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (error) {
    return fail(error);
  }
}

function objParam(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

const S = (description: string) => ({ type: "string", description });
const N = (description: string) => ({ type: "number", description });
const B = (description: string) => ({ type: "boolean", description });

// Truncate long text lists so tool results fit the context window.
function cap<T>(list: T[], n: number): { items: T[]; total: number; truncated: boolean } {
  return { items: list.slice(0, n), total: list.length, truncated: list.length > n };
}

export const AGENT_TOOLS: ToolDef[] = [
  {
    name: "brain_overview",
    description: "Voice profile, vault counts, posting strategy, and platform playbook.",
    parameters: objParam({}),
    run: async () => safe(async () => brainOverview()),
  },
  {
    name: "vault_search",
    description: "Semantic search over the context vault (voice, Q&A, principles, quotes).",
    parameters: objParam({ query: S("Search text"), limit: N("Max hits (default 5)") }),
    run: async (a) =>
      safe(async () => searchVault(str(a.query, "query"), a.limit === undefined ? 5 : num(a.limit, "limit"))),
  },
  {
    name: "list_slots",
    description: "Queue slots in a date range with status, pillar, type, draft counts.",
    parameters: objParam({
      from: S("ISO start date"),
      to: S("ISO end date"),
      status: S("Optional: red|orange|green|gray"),
    }, ["from", "to"]),
    run: async (a) =>
      safe(async () => {
        const db = getDb();
        const status = typeof a.status === "string" && a.status ? a.status : null;
        const rows = (status
          ? db.prepare(
              `SELECT s.id, s.scheduled_at, s.content_type, s.platforms, s.status, p.name AS pillar_name,
                      (SELECT COUNT(*) FROM drafts d WHERE d.slot_id = s.id) AS draft_count
               FROM queue_slots s LEFT JOIN pillars p ON p.id = s.pillar_id
               WHERE s.scheduled_at >= ? AND s.scheduled_at < ? AND s.status = ?
               ORDER BY s.scheduled_at ASC LIMIT 200`,
            ).all(str(a.from, "from"), str(a.to, "to"), status)
          : db.prepare(
              `SELECT s.id, s.scheduled_at, s.content_type, s.platforms, s.status, p.name AS pillar_name,
                      (SELECT COUNT(*) FROM drafts d WHERE d.slot_id = s.id) AS draft_count
               FROM queue_slots s LEFT JOIN pillars p ON p.id = s.pillar_id
               WHERE s.scheduled_at >= ? AND s.scheduled_at < ?
               ORDER BY s.scheduled_at ASC LIMIT 200`,
            ).all(str(a.from, "from"), str(a.to, "to"))) as unknown[];
        return rows;
      }),
  },
  {
    name: "get_slot",
    description: "Slot detail with drafts, attachments, and gen requests.",
    parameters: objParam({ slotId: S("Slot UUID") }, ["slotId"]),
    run: async (a) =>
      safe(async () => {
        const db = getDb();
        const id = uuid(a.slotId, "slotId");
        const slot = db.prepare(`SELECT * FROM queue_slots WHERE id = ?`).get(id);
        if (!slot) throw new Error("slot not found");
        const drafts = db.prepare(`SELECT * FROM drafts WHERE slot_id = ? ORDER BY created_at ASC`).all(id);
        const attachments = db.prepare(`SELECT id, kind, filename, mime, size FROM slot_attachments WHERE slot_id = ?`).all(id);
        const requests = db.prepare(`SELECT * FROM gen_requests WHERE slot_id = ?`).all(id);
        return { slot, drafts, attachments, requests };
      }),
  },
  {
    name: "set_slot_status",
    description: "Move a slot between red (needs work), orange (needs review), green (ready). Only the user marks Posted (gray).",
    parameters: objParam({ slotId: S("Slot UUID"), status: S("red|orange|green") }, ["slotId", "status"]),
    run: async (a) => {
      const status = str(a.status, "status");
      if (!["red", "orange", "green"].includes(status)) {
        return { ok: false, error: "agent may only set red|orange|green (only the user marks Posted)" };
      }
      return safe(async () => {
        const id = uuid(a.slotId, "slotId");
        const r = getDb().prepare(`UPDATE queue_slots SET status = ? WHERE id = ?`).run(status, id);
        if (r.changes === 0) throw new Error("slot not found");
        return { slotId: id, status };
      });
    },
  },
  {
    name: "edit_draft",
    description: "Replace a draft's body text (marks it edited).",
    parameters: objParam({ draftId: S("Draft UUID"), body: S("New body text") }, ["draftId", "body"]),
    run: async (a) =>
      safe(async () => {
        const id = uuid(a.draftId, "draftId");
        const r = getDb()
          .prepare(`UPDATE drafts SET body = ?, status = 'edited' WHERE id = ?`)
          .run(str(a.body, "body"), id);
        if (r.changes === 0) throw new Error("draft not found");
        return { draftId: id };
      }),
  },
  {
    name: "run_planner",
    description: "Materialize queue slots from weekly templates (default 14 days).",
    parameters: objParam({ days: N("Days ahead (default 14)") }),
    run: async (a) => safe(async () => ({ jobId: enqueue("plan", { days: a.days === undefined ? 14 : num(a.days, "days") }) })),
  },
  {
    name: "run_draft",
    description: "Draft one slot (slotId) or up to <limit> red slots.",
    parameters: objParam({ slotId: S("Optional slot UUID"), limit: N("Max slots when no slotId (default 10)") }),
    run: async (a) =>
      safe(async () => {
        if (typeof a.slotId === "string" && a.slotId) {
          return { jobId: enqueue("draft_slot", { slotId: uuid(a.slotId, "slotId") }) };
        }
        return { jobId: enqueue("draft_all", { limit: a.limit === undefined ? 10 : num(a.limit, "limit") }) };
      }),
  },
  {
    name: "list_pillars",
    description: "Content pillars with ids, names, and confirmed flags.",
    parameters: objParam({}),
    run: async () =>
      safe(async () => {
        const rows = getDb()
          .prepare(`SELECT id, name, description, confirmed FROM pillars ORDER BY confirmed DESC, name ASC`)
          .all() as unknown[];
        return rows;
      }),
  },
  {
    name: "list_templates",
    description: "Weekly queue templates (posting cadence) with pillar names.",
    parameters: objParam({}),
    run: async () =>
      safe(async () => {
        const rows = getDb()
          .prepare(
            `SELECT t.id, t.weekday, t.time, t.pillar_id, p.name AS pillar_name, t.content_type, t.platforms
             FROM queue_templates t LEFT JOIN pillars p ON p.id = t.pillar_id
             ORDER BY t.weekday, t.time LIMIT 100`,
          )
          .all() as unknown[];
        return rows;
      }),
  },
  {
    name: "add_template",
    description:
      "Add a posting time to the weekly queue. Weekdays: 0=Sun..6=Sat. Set everyday=true to add the same slot all 7 days. Pillar accepts a name (matched case-insensitively) or id. Always assign the best-fit confirmed pillar; leave it blank only when the user has none.",
    parameters: objParam(
      {
        weekday: N("0=Sunday .. 6=Saturday (ignored when everyday=true)"),
        time: S("Posting time HH:MM, 24h"),
        pillar: S("Pillar name or id (optional)"),
        content_type: S("short_post|thread|video_trend|video_series|video_yap|carousel|article_blog|article_thread|long_video|clip"),
        platforms: S("Comma-separated: x,threads,facebook,instagram,tiktok,youtube,linkedin,blog"),
        everyday: B("Add all 7 days (default false)"),
      },
      ["time", "content_type", "platforms"],
    ),
    run: async (a) =>
      safe(async () => {
        const time = str(a.time, "time");
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("time must be HH:MM (24h)");
        const contentType = str(a.content_type, "content_type");
        if (!isContentType(contentType)) throw new Error(`unknown content_type: ${contentType}`);
        const allowed = new Set<string>([...PLATFORMS]);
        const plats = str(a.platforms, "platforms")
          .split(",")
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean);
        if (plats.length === 0 || !plats.every((p) => allowed.has(p as (typeof PLATFORMS)[number]))) {
          throw new Error(`platforms must be a comma-separated subset of ${[...PLATFORMS].join(",")}`);
        }
        let pillarId: string | null = null;
        if (typeof a.pillar === "string" && a.pillar.trim()) {
          const want = a.pillar.trim().toLowerCase();
          const pillars = getDb().prepare(`SELECT id, name FROM pillars`).all() as {
            id: string;
            name: string;
          }[];
          const hit =
            pillars.find((p) => p.id === a.pillar) ??
            pillars.find((p) => p.name.toLowerCase() === want) ??
            pillars.find((p) => p.name.toLowerCase().includes(want) || want.includes(p.name.toLowerCase()));
          if (!hit) {
            throw new Error(
              `unknown pillar "${a.pillar}". Known: ${pillars.map((p) => p.name).join(", ") || "none"}`,
            );
          }
          pillarId = hit.id;
        }
        const days =
          a.everyday === true
            ? [0, 1, 2, 3, 4, 5, 6]
            : (() => {
                const w = num(a.weekday, "weekday");
                if (!Number.isInteger(w) || w < 0 || w > 6) throw new Error("weekday must be 0-6");
                return [w];
              })();
        const db = getDb();
        const dupe = db.prepare(
          `SELECT 1 FROM queue_templates WHERE weekday = ? AND time = ? AND IFNULL(pillar_id, '') = IFNULL(?, '') AND content_type = ? AND platforms = ? LIMIT 1`,
        );
        const insert = db.prepare(
          `INSERT INTO queue_templates (id, weekday, time, pillar_id, content_type, platforms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        const created: string[] = [];
        let skipped = 0;
        for (const w of days) {
          if (dupe.get(w, time, pillarId, contentType, JSON.stringify(plats))) {
            skipped++;
            continue;
          }
          const id = randomUUID();
          insert.run(id, w, time, pillarId, contentType, JSON.stringify(plats), nowIso());
          created.push(id);
        }
        return { created: created.length, skipped, ids: created };
      }),
  },
  {
    name: "delete_template",
    description: "Delete one weekly queue template by id.",
    parameters: objParam({ id: S("Template UUID") }, ["id"]),
    run: async (a) =>
      safe(async () => {
        const info = getDb().prepare(`DELETE FROM queue_templates WHERE id = ?`).run(uuid(a.id, "id"));
        if (Number(info.changes) === 0) throw new Error("template not found");
        return { deleted: true };
      }),
  },
  {
    name: "run_ingest",
    description: "Ingest a creator source. Sources: x_posts, tiktok_videos, instagram_posts (handle without @), youtube_transcript (video URL), instagram_reel (reel URL).",
    parameters: objParam({ source: S("Source key"), value: S("Handle or URL") }, ["source", "value"]),
    run: async (a) => {
      const source = str(a.source, "source");
      if (!isIngestSource(source)) return { ok: false, error: `bad source: ${source}` };
      return safe(async () => ({ jobId: enqueue("ingest", { source, value: str(a.value, "value") }) }));
    },
  },
  {
    name: "run_analysis",
    description: "Analyze unanalyzed assets into voice profile, vault, and pillars.",
    parameters: objParam({ limit: N("Max assets (default 50)") }),
    run: async (a) =>
      safe(async () => ({ jobId: enqueue("analyze", { limit: a.limit === undefined ? 50 : num(a.limit, "limit") }) })),
  },
  {
    name: "job_status",
    description: "Check a worker job's state, progress, result, or failure reason.",
    parameters: objParam({ jobId: S("Job UUID") }, ["jobId"]),
    run: async (a) =>
      safe(async () => {
        const job = getJob(uuid(a.jobId, "jobId"));
        if (!job) throw new Error("job not found");
        return { id: job.id, name: job.name, state: job.state, progress: job.progress, result: job.result, failedReason: job.failedReason };
      }),
  },
  {
    name: "list_media",
    description: "Media library assets, optionally filtered by kind video|audio|image.",
    parameters: objParam({ kind: S("Optional kind filter") }),
    run: async (a) =>
      safe(async () => {
        const { listMedia } = await import("./media");
        const kind = typeof a.kind === "string" && a.kind ? a.kind : undefined;
        if (kind && !["video", "audio", "image"].includes(kind)) throw new Error("bad kind");
        return listMedia(kind as "video" | "audio" | "image" | undefined);
      }),
  },
  {
    name: "register_media",
    description: "Register a local file path as a media asset (referenced in place).",
    parameters: objParam({ path: S("Absolute file path") }, ["path"]),
    run: async (a) =>
      safe(async () => {
        const { registerLocalFile } = await import("./media");
        return registerLocalFile(str(a.path, "path"));
      }),
  },
  {
    name: "list_carousels",
    description: "List carousel projects with slide counts.",
    parameters: objParam({}),
    run: async () =>
      safe(async () => {
        const { listProjects } = await import("./carousel");
        return listProjects();
      }),
  },
  {
    name: "create_carousel",
    description: "Create a carousel project, optionally linked to a queue slot.",
    parameters: objParam({
      title: S("Title"),
      slotId: S("Optional queue slot UUID"),
      slideCount: N("Slides (default 7)"),
    }, ["title"]),
    run: async (a) =>
      safe(async () => {
        const { addSlide, createProject } = await import("./carousel");
        const project = createProject({
          title: str(a.title, "title"),
          slot_id: typeof a.slotId === "string" && a.slotId ? uuid(a.slotId, "slotId") : null,
        });
        const n = Math.min(20, Math.max(1, Math.round(a.slideCount === undefined ? 7 : num(a.slideCount, "slideCount"))));
        for (let i = 0; i < n; i++) addSlide(project.id);
        return { ...project, slide_count: n };
      }),
  },
  {
    name: "get_carousel",
    description: "Carousel project with slides, photos, and pending gen requests.",
    parameters: objParam({ projectId: S("Carousel project UUID") }, ["projectId"]),
    run: async (a) =>
      safe(async () => {
        const { getProject, listSlides } = await import("./carousel");
        const id = uuid(a.projectId, "projectId");
        const project = getProject(id);
        if (!project) throw new Error("carousel not found");
        const requests = getDb()
          .prepare(`SELECT * FROM gen_requests WHERE project_id = ? ORDER BY created_at ASC`)
          .all(id);
        return { project, slides: listSlides(id), requests };
      }),
  },
  {
    name: "carousel_copy",
    description: "Draft slide copy for a carousel from the vault (enqueues a job).",
    parameters: objParam({ projectId: S("Carousel project UUID"), brief: S("Optional brief") }, ["projectId"]),
    run: async (a) =>
      safe(async () => ({
        jobId: enqueue("carousel_copy", {
          projectId: uuid(a.projectId, "projectId"),
          brief: typeof a.brief === "string" ? a.brief : "",
        }),
      })),
  },
  {
    name: "carousel_autopick",
    description: "Auto-pick ingested photos for each slide (enqueues a job).",
    parameters: objParam({ projectId: S("Carousel project UUID") }, ["projectId"]),
    run: async (a) =>
      safe(async () => ({ jobId: enqueue("carousel_autopick", { projectId: uuid(a.projectId, "projectId") }) })),
  },
  {
    name: "carousel_plan_images",
    description: "Request image generations for slides (approval-gated, spends nothing until approved).",
    parameters: objParam({ projectId: S("Carousel project UUID") }, ["projectId"]),
    run: async (a) =>
      safe(async () => ({ jobId: enqueue("carousel_plan_images", { projectId: uuid(a.projectId, "projectId") }) })),
  },
  {
    name: "edit_slide",
    description: "Edit a carousel slide's heading/body directly.",
    parameters: objParam({
      slideId: S("Slide UUID"),
      heading: S("Optional heading"),
      body: S("Optional body"),
    }, ["slideId"]),
    run: async (a) =>
      safe(async () => {
        const { updateSlide } = await import("./carousel");
        const edit: { heading?: string; body?: string } = {};
        if (typeof a.heading === "string") edit.heading = a.heading;
        if (typeof a.body === "string") edit.body = a.body;
        const slide = updateSlide(uuid(a.slideId, "slideId"), edit);
        if (!slide) throw new Error("slide not found");
        return slide;
      }),
  },
  {
    name: "list_video_projects",
    description: "List video projects with track counts.",
    parameters: objParam({}),
    run: async () =>
      safe(async () => {
        const db = getDb();
        return db.prepare(
          `SELECT p.*, (SELECT COUNT(*) FROM video_tracks t WHERE t.project_id = p.id) AS track_count
           FROM video_projects p ORDER BY p.updated_at DESC`,
        ).all();
      }),
  },
  {
    name: "create_video_project",
    description: "Create a video project with the default track stack, optionally linked to a slot.",
    parameters: objParam({ title: S("Title"), slotId: S("Optional queue slot UUID") }, ["title"]),
    run: async (a) =>
      safe(async () => {
        const db = getDb();
        const id = randomUUID();
        const ts = nowIso();
        const slotId = typeof a.slotId === "string" && a.slotId ? uuid(a.slotId, "slotId") : null;
        db.prepare(
          `INSERT INTO video_projects (id, slot_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(id, slotId, str(a.title, "title"), ts, ts);
        const names: Array<[string, string, number]> = [
          ["video", "Subject (keyed)", 0],
          ["graphics", "Graphics", 1],
          ["video", "Main", 2],
          ["audio", "Audio", 3],
          ["caption", "Captions", 4],
          ["review", "Review", 5],
        ];
        const insert = db.prepare(
          `INSERT INTO video_tracks (id, project_id, kind, name, position, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const [kind, name, position] of names) insert.run(randomUUID(), id, kind, name, position, ts);
        return { id, slotId };
      }),
  },
  {
    name: "get_timeline",
    description: "Full project timeline: tracks, clips, captions, review notes.",
    parameters: objParam({ projectId: S("Video project UUID") }, ["projectId"]),
    run: async (a) =>
      safe(async () => {
        const { getProjectDetail } = await import("./video");
        const detail = getProjectDetail(uuid(a.projectId, "projectId"));
        if (!detail) throw new Error("project not found");
        return detail;
      }),
  },
  {
    name: "add_clip",
    description: "Add a clip to a track (append, or ripple-insert at atMs).",
    parameters: objParam({
      trackId: S("Track UUID"),
      assetId: S("Optional media asset UUID"),
      name: S("Optional clip name"),
      inMs: N("Source in-point ms (default 0)"),
      durationMs: N("Duration ms"),
      atMs: N("Optional timeline insert point ms"),
    }, ["trackId", "durationMs"]),
    run: async (a) =>
      safe(async () => {
        const { addClip } = await import("./video");
        return addClip({
          trackId: uuid(a.trackId, "trackId"),
          assetId: typeof a.assetId === "string" && a.assetId ? uuid(a.assetId, "assetId") : null,
          name: typeof a.name === "string" ? a.name : undefined,
          inMs: a.inMs === undefined ? 0 : num(a.inMs, "inMs"),
          durationMs: num(a.durationMs, "durationMs"),
          atMs: a.atMs === undefined ? undefined : num(a.atMs, "atMs"),
        });
      }),
  },
  {
    name: "edit_clip",
    description: "Ripple-trim (inMs/durationMs) or move (startMs) a clip. Trims ripple by default.",
    parameters: objParam({
      clipId: S("Clip UUID"),
      inMs: N("Optional new source in-point"),
      durationMs: N("Optional new duration"),
      startMs: N("Optional move (no ripple)"),
      ripple: B("Ripple on trim (default true)"),
    }, ["clipId"]),
    run: async (a) =>
      safe(async () => {
        const { moveClip, trimClip } = await import("./video");
        const id = uuid(a.clipId, "clipId");
        if (typeof a.startMs === "number") return moveClip(id, a.startMs);
        return trimClip(
          id,
          {
            inMs: typeof a.inMs === "number" ? a.inMs : undefined,
            durationMs: typeof a.durationMs === "number" ? a.durationMs : undefined,
          },
          a.ripple !== false,
        );
      }),
  },
  {
    name: "split_clip",
    description: "Split a clip at a timeline ms.",
    parameters: objParam({ clipId: S("Clip UUID"), atMs: N("Timeline ms") }, ["clipId", "atMs"]),
    run: async (a) =>
      safe(async () => {
        const { splitClip } = await import("./video");
        return splitClip(uuid(a.clipId, "clipId"), num(a.atMs, "atMs"));
      }),
  },
  {
    name: "delete_clip",
    description: "Delete a clip (ripple-close the gap by default).",
    parameters: objParam({ clipId: S("Clip UUID"), ripple: B("Ripple (default true)") }, ["clipId"]),
    run: async (a) =>
      safe(async () => {
        const { deleteClip } = await import("./video");
        return deleteClip(uuid(a.clipId, "clipId"), a.ripple !== false);
      }),
  },
  {
    name: "transcribe_asset",
    description: "Transcribe footage to word timecodes (enqueues a job; minutes on CPU).",
    parameters: objParam({ assetId: S("Media asset UUID") }, ["assetId"]),
    run: async (a) =>
      safe(async () => ({ jobId: enqueue("transcribe", { assetId: uuid(a.assetId, "assetId") }) })),
  },
  {
    name: "get_transcript",
    description: "Transcript words with timecodes (truncated past 300 words).",
    parameters: objParam({ assetId: S("Media asset UUID") }, ["assetId"]),
    run: async (a) =>
      safe(async () => {
        const { getTranscript } = await import("./transcribe");
        const { transcript, words } = getTranscript(uuid(a.assetId, "assetId"));
        if (!transcript) throw new Error("no transcript yet — run transcribe_asset first");
        return { transcript, ...cap(words, 300) };
      }),
  },
  {
    name: "autocut_asset",
    description: "Detect repeated takes + silence on transcribed footage. Returns takes.",
    parameters: objParam({ assetId: S("Media asset UUID") }, ["assetId"]),
    run: async (a) =>
      safe(async () => {
        const { detectTakes, saveTakes } = await import("./autocut");
        const { getTranscript } = await import("./transcribe");
        const { transcript, words } = getTranscript(uuid(a.assetId, "assetId"));
        if (!transcript) throw new Error("transcribe first");
        return { transcriptId: transcript.id, takes: saveTakes(transcript.id, detectTakes(words)) };
      }),
  },
  {
    name: "apply_takes",
    description: "Replace a track's contents with one clip per kept take.",
    parameters: objParam({ trackId: S("Track UUID"), assetId: S("Footage asset UUID") }, ["trackId", "assetId"]),
    run: async (a) =>
      safe(async () => {
        const { applyTakesToTrack, getTakesByAsset } = await import("./autocut");
        const assetId = uuid(a.assetId, "assetId");
        const { takes } = getTakesByAsset(assetId);
        if (takes.length === 0) throw new Error("run autocut_asset first");
        return applyTakesToTrack(uuid(a.trackId, "trackId"), assetId, takes);
      }),
  },
  {
    name: "add_note",
    description: "Add a review note over a timeline range.",
    parameters: objParam({
      projectId: S("Project UUID"),
      startMs: N("Range start ms"),
      endMs: N("Range end ms"),
      body: S("Note text"),
    }, ["projectId", "startMs", "endMs", "body"]),
    run: async (a) =>
      safe(async () => {
        const { addNote } = await import("./video");
        return addNote({
          projectId: uuid(a.projectId, "projectId"),
          startMs: num(a.startMs, "startMs"),
          endMs: num(a.endMs, "endMs"),
          body: str(a.body, "body"),
        });
      }),
  },
  {
    name: "caption_generate",
    description: "Generate caption blocks from an asset's transcript mapped onto the timeline.",
    parameters: objParam({
      projectId: S("Project UUID"),
      assetId: S("Footage asset UUID"),
      wordsPerLine: N("Words per line (default 4)"),
      replace: B("Replace existing captions (default false)"),
    }, ["projectId", "assetId"]),
    run: async (a) =>
      safe(async () => {
        const { clearCaptions, generateCaptions } = await import("./captions");
        const { getTranscript } = await import("./transcribe");
        const projectId = uuid(a.projectId, "projectId");
        const { transcript, words } = getTranscript(uuid(a.assetId, "assetId"));
        if (!transcript) throw new Error("transcribe first");
        if (a.replace === true) clearCaptions(projectId);
        return {
          captions: generateCaptions(projectId, uuid(a.assetId, "assetId"), words, {
            wordsPerLine: a.wordsPerLine === undefined ? 4 : num(a.wordsPerLine, "wordsPerLine"),
          }),
        };
      }),
  },
  {
    name: "caption_edit",
    description: "Edit a caption block: retime, rewrite lines (array of text), enable/disable.",
    parameters: objParam({
      captionId: S("Caption UUID"),
      startMs: N("Optional new start ms"),
      endMs: N("Optional new end ms"),
      lines: S("Optional JSON array of line texts"),
      enabled: B("Optional on/off"),
    }, ["captionId"]),
    run: async (a) =>
      safe(async () => {
        const { listCaptions, updateCaption } = await import("./captions");
        void listCaptions;
        const id = uuid(a.captionId, "captionId");
        let lines: { text: string; start_ms: number; end_ms: number }[] | undefined;
        if (typeof a.lines === "string" && a.lines) {
          const texts = JSON.parse(a.lines) as unknown;
          if (!Array.isArray(texts)) throw new Error("lines must be a JSON array of strings");
          const start = typeof a.startMs === "number" ? a.startMs : 0;
          const end = typeof a.endMs === "number" ? a.endMs : start;
          const span = Math.max(1, end - start);
          lines = (texts as unknown[]).map((t, i) => ({
            text: String(t),
            start_ms: Math.round(start + (span * i) / Math.max(1, texts.length)),
            end_ms: Math.round(start + (span * (i + 1)) / Math.max(1, texts.length)),
          }));
        }
        const block = updateCaption(id, {
          start_ms: typeof a.startMs === "number" ? a.startMs : undefined,
          end_ms: typeof a.endMs === "number" ? a.endMs : undefined,
          enabled: typeof a.enabled === "boolean" ? (a.enabled ? 1 : 0) : undefined,
          lines,
        });
        if (!block) throw new Error("caption not found");
        return block;
      }),
  },
  {
    name: "graphics_add",
    description: "Add a text card to a graphics track at a timeline ms.",
    parameters: objParam({
      trackId: S("Graphics track UUID"),
      text: S("Card text"),
      atMs: N("Timeline ms"),
      durationMs: N("Duration ms (default 3000)"),
      yPct: N("Vertical position percent (default 12)"),
    }, ["trackId", "text", "atMs"]),
    run: async (a) =>
      safe(async () => {
        const { addClip } = await import("./video");
        return addClip({
          trackId: uuid(a.trackId, "trackId"),
          name: str(a.text, "text").slice(0, 40),
          durationMs: a.durationMs === undefined ? 3000 : num(a.durationMs, "durationMs"),
          atMs: num(a.atMs, "atMs"),
          payload: {
            text: str(a.text, "text"),
            y_pct: a.yPct === undefined ? 12 : num(a.yPct, "yPct"),
            fontsize: 72,
            color: "white",
            box: true,
          },
        });
      }),
  },
  {
    name: "audio_search",
    description: "Search the free library (Wikimedia Commons) for SFX or music.",
    parameters: objParam({ query: S("Search text"), limit: N("Max results (default 10)") }),
    run: async (a) =>
      safe(async () => {
        const { searchCommons } = await import("./audio");
        return searchCommons(str(a.query, "query"), a.limit === undefined ? 10 : num(a.limit, "limit"));
      }),
  },
  {
    name: "audio_fetch",
    description: "Download a search result into the SFX or music library.",
    parameters: objParam({
      kind: S("sfx|music"),
      title: S("Result title"),
      url: S("Result download URL"),
      durationMs: N("Optional duration ms"),
      license: S("Optional license"),
    }, ["kind", "title", "url"]),
    run: async (a) => {
      const kind = str(a.kind, "kind");
      if (kind !== "sfx" && kind !== "music") return { ok: false, error: "kind must be sfx|music" };
      const url = str(a.url, "url");
      if (!url.startsWith("https://upload.wikimedia.org/")) {
        return { ok: false, error: "only upload.wikimedia.org downloads allowed" };
      }
      return safe(async () => {
        const { fetchCommonsAudio } = await import("./audio");
        return fetchCommonsAudio(kind, {
          title: str(a.title, "title"),
          url,
          size: null,
          duration_ms: typeof a.durationMs === "number" ? a.durationMs : null,
          license: typeof a.license === "string" ? a.license : null,
          license_url: null,
          artist: null,
          description: null,
        });
      });
    },
  },
  {
    name: "audio_to_timeline",
    description: "Drop a library entry onto the project's first audio track (append or at ms).",
    parameters: objParam({
      entryId: S("Audio library entry UUID"),
      projectId: S("Project UUID"),
      atMs: N("Optional timeline ms (ripple-insert)"),
    }, ["entryId", "projectId"]),
    run: async (a) =>
      safe(async () => {
        const { audioToTimeline } = await import("./audio");
        return audioToTimeline(
          uuid(a.entryId, "entryId"),
          uuid(a.projectId, "projectId"),
          typeof a.atMs === "number" ? a.atMs : undefined,
        );
      }),
  },
  {
    name: "key_clip",
    description: "Cut the subject out of a clip with CorridorKey (local GPU; lands on Subject track).",
    parameters: objParam({ clipId: S("Clip UUID") }, ["clipId"]),
    run: async (a) =>
      safe(async () => ({ jobId: enqueue("key_clip", { clipId: uuid(a.clipId, "clipId") }) })),
  },
  {
    name: "export_video",
    description: "Render the project to H.264 MP4 (enqueues a job).",
    parameters: objParam({
      projectId: S("Project UUID"),
      burnCaptions: B("Burn captions (default true)"),
    }, ["projectId"]),
    run: async (a) =>
      safe(async () => ({
        jobId: enqueue("export_video", {
          projectId: uuid(a.projectId, "projectId"),
          burnCaptions: a.burnCaptions !== false,
        }),
      })),
  },
];
