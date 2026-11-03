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
  isWeakFit,
  parseSlotPlatforms,
  platformFitFor,
} from "./platform-fit";
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
function fitForSlot(slot: SlotRow): { platformsLine: string; fitSection: string; weak: boolean } {
  const platforms = parseSlotPlatforms(slot.platforms);
  const fits = platformFitFor(slot.pillar_id, platforms, slot.content_type);
  const fitSection = buildFitSection(fits, slot.pillar_name);
  return {
    platformsLine: platforms.length > 0 ? platforms.join(", ") : "(no platforms set)",
    fitSection: fitSection ? `\n\n${fitSection}` : "",
    weak: fits.some(isWeakFit),
  };
}

// On a weak platform fit the voice mandate gets an explicit exception at
// its own site: a distant paragraph can't override identity-level habits
// ("opens almost everything with…") on its own (probed live).
function voiceSectionFor(weak: boolean): string {
  const voice = getVoice();
  if (!voice) return "(no voice profile yet — write in a clear, confident creator voice)";
  const framing = weak
    ? "VOICE PROFILE (match every rule below exactly, with ONE exception: PLATFORM FIT flags a WEAK FIT for this draft — drop your default opener habit for this draft and open like that platform's winners instead)"
    : "VOICE PROFILE (match every rule below exactly)";
  return `${framing}:\n${voice.body.slice(0, 6000)}`;
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

async function draftOne(slot: SlotRow): Promise<void> {
  const metaKey = loadKeys().meta;
  if (!metaKey) throw new Error("save a Meta key in Settings first");
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
  const voiceSection = voiceSectionFor(fit.weak);
  const query = `${slot.pillar_name ?? ""} ${typeLabel} ${(slot.content_type as ContentType) ?? ""}`.trim();
  const hits = await searchVault(query || "voice", 5);
  const context = buildDraftContext(
    hits.map((h) => ({ doc_type: h.doc_type, title: h.title, body: h.body })),
  );
  const rules = rulesFor(slot.pillar_id, slot.content_type);
  const rulesSection =
    rules.length > 0
      ? `\n\nHOUSE RULES (distilled from your past feedback — follow every one):\n${rules.map((r) => `- ${r.rule}`).join("\n")}`
      : "";

  // Medium effort, uncapped output: capped budgets starve the draft when
  // reasoning runs long (probed live), and drafts deserve full quality.
  const client = getMetaClient(metaKey);
  const input = `You are the creator's ghostwriter.\n\n${voiceSection}\n\n${pillarLine}${pillarVoice}\nContent type: ${typeLabel}\nPlatforms: ${fit.platformsLine}${rulesSection}${fit.fitSection}\n\n${guideFor(slot.content_type)}\n\nVAULT CONTEXT:\n${context}`;
  const call = (text: string) =>
    client.responses.create(
      {
        model: metaTextModel(),
        input: text,
        reasoning: { effort: "medium" },
      },
      { timeout: 180000 },
    );
  let resp = await call(input);
  let body = resp.output_text.trim();
  if (!body) {
    resp = await call(`${input}\n\nYour previous response was empty. Write the draft now — no preamble.`);
    body = resp.output_text.trim();
  }
  if (!body) {
    throw new Error(
      `model returned an empty draft (status: ${String((resp as { status?: unknown }).status ?? "unknown")})`,
    );
  }
  saveDraft(slot.id, slot.content_type, body);
}

export function saveDraft(slotId: string, kind: string, body: string): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO drafts (id, slot_id, kind, body, status, created_at)
     VALUES (?, ?, ?, ?, 'draft', ?)`,
  ).run(id, slotId, kind, body, nowIso());
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

// Pure redraft prompt: previous draft + the creator's note, same voice and
// house rules as a fresh draft. The new draft is appended, never replaces.
export function buildRedraftInput(
  previous: string,
  feedback: string,
  voiceSection: string,
  pillarLine: string,
  typeLabel: string,
  platforms: string,
  rulesSection: string,
  fitSection = "",
): string {
  return `You are the creator's ghostwriter revising a draft.

${voiceSection}

${pillarLine}
Content type: ${typeLabel}
Platforms: ${platforms}${rulesSection}${fitSection}

PREVIOUS DRAFT:
${previous}

CREATOR FEEDBACK (address every point):
${feedback}

Rewrite the draft in full. Keep what the feedback doesn't touch; change everything it does. Output only the revised draft, no preamble.`;
}

function latestDraft(slotId: string): { id: string; body: string } | null {
  return (
    (getDb()
      .prepare(`SELECT id, body FROM drafts WHERE slot_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(slotId) as { id: string; body: string } | undefined) ?? null
  );
}

export async function runRedraftSlot(slotId: string, feedback: string): Promise<string> {
  const note = feedback.trim();
  if (!note) throw new Error("feedback is empty");
  const slot = loadSlot(slotId);
  if (!slot) throw new Error("slot not found");
  const prev = latestDraft(slotId);
  if (!prev) throw new Error("draft this slot before giving feedback");
  const metaKey = loadKeys().meta;
  if (!metaKey) throw new Error("save a Meta key in Settings first");
  const fit = fitForSlot(slot);
  const voiceSection = voiceSectionFor(fit.weak);
  const pillarLine = slot.pillar_name ? `Pillar: ${slot.pillar_name}` : "Pillar: (none assigned)";
  const typeLabel =
    (CONTENT_TYPES as Record<string, { label: string }>)[slot.content_type]?.label ??
    slot.content_type;
  const rules = rulesFor(slot.pillar_id, slot.content_type);
  const rulesSection =
    rules.length > 0
      ? `\n\nHOUSE RULES (distilled from your past feedback — follow every one):\n${rules.map((r) => `- ${r.rule}`).join("\n")}`
      : "";
  const client = getMetaClient(metaKey);
  const input = buildRedraftInput(
    prev.body,
    note,
    voiceSection,
    pillarLine,
    typeLabel,
    fit.platformsLine,
    rulesSection,
    fit.fitSection,
  );
  const call = (text: string) =>
    client.responses.create(
      { model: metaTextModel(), input: text, reasoning: { effort: "medium" } },
      { timeout: 180000 },
    );
  let resp = await call(input);
  let body = resp.output_text.trim();
  if (!body) {
    resp = await call(`${input}\n\nYour previous response was empty. Write the revised draft now — no preamble.`);
    body = resp.output_text.trim();
  }
  if (!body) {
    throw new Error(
      `model returned an empty redraft (status: ${String((resp as { status?: unknown }).status ?? "unknown")})`,
    );
  }
  saveFeedback(slotId, prev.id, note);
  return saveDraft(slot.id, slot.content_type, body);
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
