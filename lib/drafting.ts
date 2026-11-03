// Slot drafting: red slots get Meta-written drafts grounded in the vault,
// then flip to orange for review.
import { randomUUID } from "node:crypto";
import { getVoice } from "./brain";
import { CONTENT_TYPES, PLAYBOOK, type ContentType } from "./content";
import { getDb, nowIso } from "./db";
import { rulesFor, saveFeedback } from "./feedback";
import { loadKeys } from "./keys";
import { getMetaClient, metaTextModel } from "./meta";
import {
  buildFitSection,
  buildPillarSection,
  isWeakFit,
  parseSlotPlatforms,
  platformFitFor,
} from "./platform-fit";
import { craftBlock } from "./social-craft";
import { buildNewsSection, fetchNews, needsNews } from "./news-ground";
import { searchVault } from "./vault";

export type DraftResult = {
  drafted: number;
  skipped: number;
  failures: Array<{ slot: string; error: string }>;
};

type SlotRow = {
  id: string;
  scheduled_at: string;
  pillar_id: string | null;
  pillar_name: string | null;
  pillar_desc: string | null;
  pillar_voice: string | null;
  content_type: string;
  platforms: string;
};

function guideFor(contentType: string): string {
  return PLAYBOOK[contentType] ?? "Write the content for this slot.";
}

// Measured pillar×platform fit for the prompt, plus a human-readable
// platform list (slots store JSON like ["x","threads"]).
function fitForSlot(slot: SlotRow): {
  platformsLine: string;
  fitSection: string;
  pillarSection: string;
  weak: boolean;
  pillarFormat: boolean;
} {
  const platforms = parseSlotPlatforms(slot.platforms);
  const fits = platformFitFor(slot.pillar_id, platforms, slot.content_type);
  const fitSection = buildFitSection(fits, slot.pillar_name);
  const pillar = buildPillarSection(slot.pillar_id, slot.pillar_name, platforms);
  return {
    platformsLine: platforms.length > 0 ? platforms.join(", ") : "(no platforms set)",
    fitSection: fitSection ? `\n\n${fitSection}` : "",
    pillarSection: pillar.section ? `\n\n${pillar.section}` : "",
    weak: fits.some(isWeakFit),
    pillarFormat: pillar.hasFormat,
  };
}

// Voice mandate with composed exceptions at its own site: a distant
// paragraph can't override identity-level habits ("opens almost everything
// with…") on its own (probed live) — and the pillar's own format beats
// global habits whenever the pillar has one.
export function voiceFraming(weak: boolean, pillarFormat: boolean): string {
  let framing = "VOICE PROFILE (match every rule below exactly";
  if (weak) {
    framing +=
      ", with ONE exception: PLATFORM FIT flags a WEAK FIT for this draft — drop your default opener habit for this draft and open like that platform's winners instead";
  }
  if (pillarFormat) {
    framing +=
      ", and where THIS PILLAR'S WINNERS show this pillar doing it differently, the pillar's format wins over any global habit";
  }
  return `${framing})`;
}

function voiceSectionFor(weak: boolean, pillarFormat: boolean): string {
  const voice = getVoice();
  if (!voice) return "(no voice profile yet — write in a clear, confident creator voice)";
  return `${voiceFraming(weak, pillarFormat)}:\n${voice.body.slice(0, 6000)}`;
}

export type DraftOption = { label: string; body: string };

export type DraftStructure = {
  layout: "pick-one" | "hooks-plus-body" | "prose";
  options: DraftOption[];
  body?: string;
};

// Fan-out: N single-purpose calls, structure assembled in code. The model
// never emits JSON or numbered multi-part blobs — each call returns one
// plain-text piece, so there is nothing brittle to parse.
export type FanoutCall = { key: string; label: string; prompt: string; role: "option" | "body" };

const VARIANT_ANGLES = [
  { label: "Contrarian", instruction: "Lead with the most contrarian or surprising point." },
  { label: "Proof", instruction: "Lead with a concrete number, result, or specific example." },
  { label: "Curiosity", instruction: "Open with a curiosity gap or question." },
];

const HOOK_ANGLES = [
  { label: "Bold claim", instruction: "a bold, specific claim" },
  { label: "Surprising stat", instruction: "a surprising number or fact" },
  { label: "Curiosity gap", instruction: "a curiosity gap or open loop" },
];

export type FanoutContext = {
  voiceSection: string;
  pillarLine: string;
  pillarVoice: string;
  typeLabel: string;
  platforms: string[];
  platformsLine: string;
  rulesSection: string;
  fitSection: string;
  pillarSection: string;
  newsSection: string;
  newsy: boolean;
  vaultContext: string;
  previous?: string;
  feedback?: string;
};

function headerFor(ctx: FanoutContext, revising: boolean): string {
  const role = revising ? "revising a draft" : "the creator's ghostwriter";
  let out = `You are ${role}.\n\n${ctx.voiceSection}\n\n${ctx.pillarLine}${ctx.pillarVoice}\nContent type: ${ctx.typeLabel}\nPlatforms: ${ctx.platformsLine}${ctx.rulesSection}${ctx.fitSection}${ctx.pillarSection}${ctx.newsSection}`;
  if (revising && ctx.previous) out += `\n\nPREVIOUS DRAFT:\n${ctx.previous}`;
  if (revising && ctx.feedback) {
    out += `\n\nCREATOR FEEDBACK (address every point):\n${ctx.feedback}\n\nKeep what the feedback doesn't touch; change everything it does.`;
  }
  return out;
}

// Pure prompt builder: one prompt per call, angle injected by code.
export function buildFanoutPrompts(kind: string, ctx: FanoutContext): FanoutCall[] {
  const revising = !!ctx.feedback;
  const header = headerFor(ctx, revising);
  const vault = `\n\nVAULT CONTEXT:\n${ctx.vaultContext}`;
  const craft = craftBlock(ctx.platforms, kind);
  const craftSection = craft ? `\n\n${craft}` : "";
  if (kind === "short_post") {
    return VARIANT_ANGLES.map((a, i) => ({
      key: `variant-${i}`,
      label: a.label,
      role: "option" as const,
      prompt: `${header}\n\n${guideFor(kind)}\nAngle for this variant: ${a.instruction}\nSCOPE: this slot drafts ONE standalone post. The platform rules above may describe threads — ignore all thread advice for this slot; apply only single-post hook rules.${craftSection}${vault}`,
    }));
  }
  if (kind === "thread") {
    const hooks: FanoutCall[] = HOOK_ANGLES.map((a, i) => ({
      key: `hook-${i}`,
      label: a.label,
      role: "option" as const,
      prompt: `${header}\n\nWrite exactly ONE hook post under 280 characters for a thread on this brief. Make it ${a.instruction} Output only the hook, no preamble, no numbering.${craftSection}${vault}`,
    }));
    hooks.push({
      key: "thread-body",
      label: "Thread",
      role: "body" as const,
      prompt: `${header}\n\n${guideFor(kind)}${craftSection}${vault}`,
    });
    return hooks;
  }
  return [
    {
      key: "draft",
      label: "Draft",
      role: "body" as const,
      prompt: `${header}\n\n${guideFor(kind)}${vault}`,
    },
  ];
}

// Pure assembly: texts in, structure out. Partial success is fine — a draft
// with 2 of 3 variants still reviews. Null only when nothing usable exists.
export function assembleStructure(
  kind: string,
  outputs: Map<string, string>,
): { structure: DraftStructure; body: string } | null {
  const text = (key: string): string | null => {
    const v = (outputs.get(key) ?? "").trim();
    return v ? v : null;
  };
  if (kind === "short_post") {
    const options: DraftOption[] = [];
    VARIANT_ANGLES.forEach((a, i) => {
      const t = text(`variant-${i}`);
      if (t) options.push({ label: a.label, body: t });
    });
    if (options.length === 0) return null;
    return {
      structure: { layout: "pick-one", options },
      body: options.map((o, i) => `Option ${i + 1} (${o.label}):\n${o.body}`).join("\n\n---\n\n"),
    };
  }
  if (kind === "thread") {
    const options: DraftOption[] = [];
    HOOK_ANGLES.forEach((a, i) => {
      const t = text(`hook-${i}`);
      if (t) options.push({ label: a.label, body: t });
    });
    const posts = text("thread-body");
    if (options.length === 0 || !posts) return null;
    return {
      structure: { layout: "hooks-plus-body", options, body: posts },
      body: `Hook options:\n${options.map((o, i) => `${i + 1}. ${o.body}`).join("\n")}\n\n---\n\nThread:\n${posts}`,
    };
  }
  const single = text("draft");
  if (!single) return null;
  return {
    structure: { layout: "prose", options: [{ label: "Draft", body: single }] },
    body: single,
  };
}

export type VaultHit = { doc_type: string; title?: string | null; body: string };

// Join vault hits into bounded context: full bodies would let one long doc
// swallow the prompt, so each hit is capped and the total is capped.
export function buildDraftContext(hits: VaultHit[], maxChars = 4000): string {
  if (hits.length === 0) return "(vault is empty)";
  const perHit = Math.max(500, Math.floor(maxChars / hits.length));
  const full = hits
    .map((h) => `[${h.doc_type}] ${h.title ?? ""}\n${h.body.slice(0, perHit)}`)
    .join("\n\n---\n\n");
  return full.length > maxChars ? `${full.slice(0, maxChars)}…[truncated]` : full;
}

async function buildFanoutContext(
  slot: SlotRow,
  previous?: string,
  feedback?: string,
): Promise<FanoutContext> {
  const typeLabel =
    (CONTENT_TYPES as Record<string, { label: string }>)[slot.content_type]?.label ??
    slot.content_type;
  const pillarLine = slot.pillar_name
    ? `Pillar: ${slot.pillar_name}${slot.pillar_desc ? ` — ${slot.pillar_desc}` : ""}`
    : "Pillar: (none assigned)";
  const pillarVoice =
    slot.pillar_voice && slot.pillar_voice.trim()
      ? `\nPillar voice: ${slot.pillar_voice.trim()}`
      : "";
  // The voice profile is injected directly — never left to retrieval luck.
  const fit = fitForSlot(slot);
  const query = `${slot.pillar_name ?? ""} ${typeLabel} ${(slot.content_type as ContentType) ?? ""}`.trim();
  const newsy = needsNews(slot.pillar_name, slot.pillar_desc);
  const [hits, newsItems] = await Promise.all([
    searchVault(query || "voice", 5),
    (async () => {
      if (!newsy || !slot.pillar_name) return null;
      const braveKey = loadKeys().brave;
      if (!braveKey) return [];
      try {
        return await fetchNews(braveKey, slot.pillar_name);
      } catch {
        return [];
      }
    })(),
  ]);
  const rules = rulesFor(slot.pillar_id, slot.content_type);
  const newsSection = newsItems === null ? "" : `\n\n${buildNewsSection(newsItems)}`;
  const newsyFlag = newsItems !== null;
  return {
    voiceSection: voiceSectionFor(fit.weak, fit.pillarFormat),
    pillarLine,
    pillarVoice,
    typeLabel,
    platforms: parseSlotPlatforms(slot.platforms),
    platformsLine: fit.platformsLine,
    rulesSection:
      rules.length > 0
        ? `\n\nHOUSE RULES (distilled from your past feedback — follow every one):\n${rules.map((r) => `- ${r.rule}`).join("\n")}`
        : "",
    fitSection: fit.fitSection,
    pillarSection: fit.pillarSection,
    newsSection,
    newsy: newsyFlag,
    vaultContext: buildDraftContext(
      hits.map((h) => ({ doc_type: h.doc_type, title: h.title, body: h.body })),
    ),
    previous,
    feedback,
  };
}

type MetaClient = ReturnType<typeof getMetaClient>;

// Medium effort, uncapped output: capped budgets starve the draft when
// reasoning runs long (probed live), and drafts deserve full quality.
// Returns "" when both attempts come back empty — the caller decides.
async function callText(client: MetaClient, prompt: string): Promise<string> {
  let resp = await client.responses.create(
    { model: metaTextModel(), input: prompt, reasoning: { effort: "medium" } },
    { timeout: 180000 },
  );
  let body = resp.output_text.trim();
  if (!body) {
    resp = await client.responses.create(
      {
        model: metaTextModel(),
        input: `${prompt}\n\nYour previous response was empty. Write it now — no preamble.`,
        reasoning: { effort: "medium" },
      },
      { timeout: 180000 },
    );
    body = resp.output_text.trim();
  }
  return body;
}

// Hard character limits, enforced in code — a "stay under N" line in the
// prompt is a suggestion the model ignores (probed live: thread-length
// "short posts"). Counts code points so emoji don't cheat.
const CHAR_LIMITS: Record<string, number> = { short_post: 280, thread: 280 };

export function overLimit(kind: string, text: string): number {
  const limit = CHAR_LIMITS[kind];
  if (!limit) return 0;
  return Math.max(0, Array.from(text.trim()).length - limit);
}

export async function runFanout(
  client: MetaClient,
  kind: string,
  calls: FanoutCall[],
  newsy = false,
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    calls.map(async (c) => [c.key, await callText(client, c.prompt)] as const),
  );
  const out = new Map(entries);
  // Soft completeness pass for news options: a news post with no concrete
  // fact (no digit anywhere) gets one retry naming specifics. Accepted
  // whatever comes back — unlike length, vagueness never drops an option.
  if (newsy) {
    for (const c of calls.filter((x) => x.role === "option")) {
      const body = (out.get(c.key) ?? "").trim();
      if (!body || /\d/.test(body)) continue;
      const retry = (
        await callText(
          client,
          `${c.prompt}\n\nToo vague — add one concrete fact from the news (a name, number, or date). Same angle, no padding. Output only the post.`,
        )
      ).trim();
      if (retry) out.set(c.key, retry);
    }
  }
  // Repair pass: over-limit options get one retry with the overage stated,
  // then are dropped. Limits apply to options only — thread bodies are
  // multi-post by design (each post carries its own limit in-prompt).
  const limit = CHAR_LIMITS[kind];
  if (limit) {
    for (const c of calls.filter((x) => x.role === "option")) {
      const body = (out.get(c.key) ?? "").trim();
      if (!body || overLimit(kind, body) === 0) continue;
      const over = overLimit(kind, body);
      const fixed = (
        await callText(
          client,
          `${c.prompt}\n\nYour post was ${over} characters over the ${limit} limit. Rewrite it under ${limit} characters — same angle, tighter. Output only the post.`,
        )
      ).trim();
      if (fixed && overLimit(kind, fixed) === 0) out.set(c.key, fixed);
      else out.delete(c.key);
    }
  }
  return out;
}

async function draftOne(slot: SlotRow): Promise<void> {
  const metaKey = loadKeys().meta;
  if (!metaKey) throw new Error("save a Meta key in Settings first");
  const client = getMetaClient(metaKey);
  const ctx = await buildFanoutContext(slot);
  const calls = buildFanoutPrompts(slot.content_type, ctx);
  const assembled = assembleStructure(
    slot.content_type,
    await runFanout(client, slot.content_type, calls, ctx.newsy),
  );
  if (!assembled) {
    throw new Error(`model returned an empty draft (all ${calls.length} calls came back empty)`);
  }
  saveDraft(slot.id, slot.content_type, assembled.body, assembled.structure);
}

// Full-set redraft: same fan-out as a fresh draft, with the note in every
// call. For standing notes ("no nationalism framing anywhere") that must
// reshape all options, not just the pick.
export async function runRedraftSet(slotId: string, feedback: string): Promise<string> {
  const note = feedback.trim();
  if (!note) throw new Error("feedback is empty");
  const slot = loadSlot(slotId);
  if (!slot) throw new Error("slot not found");
  const prev = latestDraft(slotId);
  if (!prev) throw new Error("draft this slot before giving feedback");
  const metaKey = loadKeys().meta;
  if (!metaKey) throw new Error("save a Meta key in Settings first");
  const client = getMetaClient(metaKey);
  const ctx = await buildFanoutContext(slot, prev.body, note);
  const calls = buildFanoutPrompts(slot.content_type, ctx);
  const assembled = assembleStructure(
    slot.content_type,
    await runFanout(client, slot.content_type, calls, ctx.newsy),
  );
  if (!assembled) {
    throw new Error(`model returned an empty redraft (all ${calls.length} calls came back empty)`);
  }
  saveFeedback(slotId, prev.id, note);
  return saveDraft(slot.id, slot.content_type, assembled.body, assembled.structure);
}

export function saveDraft(
  slotId: string,
  kind: string,
  body: string,
  structure?: DraftStructure | null,
  selection?: string | null,
): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO drafts (id, slot_id, kind, body, status, structure, selection, created_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
  ).run(
    id,
    slotId,
    kind,
    body,
    structure ? JSON.stringify(structure) : null,
    selection ?? null,
    nowIso(),
  );
  db.prepare(`UPDATE queue_slots SET status = 'orange' WHERE id = ?`).run(slotId);
  return id;
}

function loadSlot(id: string): SlotRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT s.id, s.scheduled_at, s.pillar_id, p.name AS pillar_name,
                p.description AS pillar_desc, p.voice_notes AS pillar_voice,
                s.content_type, s.platforms
         FROM queue_slots s LEFT JOIN pillars p ON p.id = s.pillar_id
         WHERE s.id = ?`,
      )
      .get(id) as SlotRow | undefined) ?? null
  );
}

function hasDrafts(slotId: string): boolean {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM drafts WHERE slot_id = ?`)
    .get(slotId) as { n: number };
  return row.n > 0;
}

export async function runDraftSlot(slotId: string): Promise<void> {
  const slot = loadSlot(slotId);
  if (!slot) throw new Error("slot not found");
  await draftOne(slot);
}

function latestDraft(slotId: string): {
  id: string;
  body: string;
  structure: string | null;
  selection: string | null;
} | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, body, structure, selection FROM drafts WHERE slot_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(slotId) as
      | { id: string; body: string; structure: string | null; selection: string | null }
      | undefined) ?? null
  );
}

export type RefineTarget = {
  text: string;
  label: string;
  layout: DraftStructure["layout"];
  threadBody?: string;
};

// Pure targeting: redraft refines the user's picked option only. Falls back
// to the whole body for legacy/edited drafts without structure.
export function refineTarget(
  kind: string,
  body: string,
  structureJson: string | null,
  selection: string | null,
): RefineTarget {
  try {
    const parsed = structureJson ? (JSON.parse(structureJson) as Partial<DraftStructure>) : null;
    if (parsed && Array.isArray(parsed.options) && parsed.options.length > 0) {
      const idx = Math.min(
        Math.max(0, Number.parseInt(selection ?? "", 10) || 0),
        parsed.options.length - 1,
      );
      const opt = parsed.options[idx];
      if (opt && typeof opt.body === "string" && opt.body.trim()) {
        const layout =
          parsed.layout === "hooks-plus-body"
            ? ("hooks-plus-body" as const)
            : parsed.layout === "pick-one"
              ? ("pick-one" as const)
              : ("prose" as const);
        return {
          text: opt.body,
          label: typeof opt.label === "string" && opt.label ? opt.label : "Draft",
          layout,
          threadBody:
            layout === "hooks-plus-body" && typeof parsed.body === "string" && parsed.body.trim()
              ? parsed.body
              : undefined,
        };
      }
    }
  } catch {
    /* fall through to whole-body */
  }
  return { text: body, label: "Draft", layout: "prose" as const };
}

export function buildRefinePrompt(kind: string, ctx: FanoutContext, target: RefineTarget): string {
  const header = headerFor(ctx, true);
  const vault = `\n\nVAULT CONTEXT:\n${ctx.vaultContext}`;
  const craft = craftBlock(ctx.platforms, kind);
  const craftSection = craft ? `\n\n${craft}` : "";
  const task =
    kind === "thread" && target.threadBody
      ? `Revise this ONE hook post (under 280 characters) for the thread below. Output only the revised hook, no preamble, no numbering.\n\nHOOK TO REVISE:\n${target.text}\n\nTHREAD IT TOPS:\n${target.threadBody}`
      : `Revise this ONE ${ctx.typeLabel.toLowerCase()} in full. Output only the revised piece, no preamble, no variants.\n\nPIECE TO REVISE:\n${target.text}`;
  return `${header}\n\n${guideFor(kind)}\n\n${task}${craftSection}${vault}`;
}

// Redraft refines the picked option only — one call, not a fresh fan-out.
// News pillars re-fetch at redraft time, so "be more specific" pulls fresh
// detail. Appended as a new single-option version, never replaces.
export async function runRedraftSlot(slotId: string, feedback: string): Promise<string> {
  const note = feedback.trim();
  if (!note) throw new Error("feedback is empty");
  const slot = loadSlot(slotId);
  if (!slot) throw new Error("slot not found");
  const prev = latestDraft(slotId);
  if (!prev) throw new Error("draft this slot before giving feedback");
  const metaKey = loadKeys().meta;
  if (!metaKey) throw new Error("save a Meta key in Settings first");
  const client = getMetaClient(metaKey);
  const target = refineTarget(slot.content_type, prev.body, prev.structure, prev.selection);
  const ctx = await buildFanoutContext(slot, prev.body, note);
  const prompt = buildRefinePrompt(slot.content_type, ctx, target);
  const refined = (await callText(client, prompt)).trim();
  if (!refined) {
    throw new Error("model returned an empty redraft (the refine call came back empty)");
  }
  if (overLimit(slot.content_type, refined) > 0) {
    // Length guard without the fan-out repair loop: one tighter retry.
    const retry = (
      await callText(
        client,
        `${prompt}\n\nToo long — rewrite it under the limit, same angle, tighter. Output only the piece.`,
      )
    ).trim();
    if (!retry) throw new Error("model returned an empty redraft (the refine call came back empty)");
    return finishRedraft(slot, prev.id, note, target, retry);
  }
  return finishRedraft(slot, prev.id, note, target, refined);
}

function finishRedraft(
  slot: SlotRow,
  prevId: string,
  note: string,
  target: RefineTarget,
  refined: string,
): string {
  const structure: DraftStructure = {
    layout: target.layout,
    options: [{ label: target.label, body: refined }],
    ...(target.threadBody ? { body: target.threadBody } : {}),
  };
  const body =
    target.layout === "hooks-plus-body" && target.threadBody
      ? `Hook:\n${refined}\n\n---\n\nThread:\n${target.threadBody}`
      : refined;
  saveFeedback(slot.id, prevId, note);
  return saveDraft(slot.id, slot.content_type, body, structure, "0");
}

export async function runDraftAll(
  limit = 10,
  onProgress?: (done: number, total: number) => void,
): Promise<DraftResult> {
  const horizon = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
  const slots = getDb()
    .prepare(
      `SELECT s.id, s.scheduled_at, s.pillar_id, p.name AS pillar_name,
              p.description AS pillar_desc, p.voice_notes AS pillar_voice,
              s.content_type, s.platforms
       FROM queue_slots s LEFT JOIN pillars p ON p.id = s.pillar_id
       WHERE s.status = 'red' AND s.scheduled_at <= ?
       ORDER BY s.scheduled_at ASC LIMIT ?`,
    )
    .all(horizon, Math.max(1, Math.min(limit, 25))) as SlotRow[];
  const out: DraftResult = { drafted: 0, skipped: 0, failures: [] };
  let done = 0;
  for (const slot of slots) {
    if (hasDrafts(slot.id)) {
      out.skipped++;
    } else {
      try {
        await draftOne(slot);
        out.drafted++;
      } catch (error) {
        out.failures.push({
          slot: slot.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    done++;
    if (onProgress) onProgress(done, slots.length);
  }
  return out;
}
