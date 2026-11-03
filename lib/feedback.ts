// Meta feedback repo: per-draft feedback distills (on approve) into small
// scoped style rules. Drafting retrieves at most 3 rules by scope match,
// so the prompt stays constant-size no matter how much feedback exists.
// SQL-only retrieval — no embeddings, no extra deps.
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";
import { loadKeys } from "./keys";
import { getMetaClient, metaTextModel } from "./meta";
import { extractJson, outputUsable } from "./analysis";

export type FeedbackRow = {
  id: string;
  slot_id: string;
  draft_id: string | null;
  body: string;
  created_at: string;
};

export type StyleRule = {
  id: string;
  pillar_id: string | null;
  content_type: string | null;
  rule: string;
  uses: number;
};

export function saveFeedback(slotId: string, draftId: string | null, body: string): string {
  const text = body.trim();
  if (!text) throw new Error("feedback is empty");
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO draft_feedback (id, slot_id, draft_id, body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, slotId, draftId, text.slice(0, 4000), nowIso());
  return id;
}

export function feedbackForSlot(slotId: string): FeedbackRow[] {
  return getDb()
    .prepare(`SELECT id, slot_id, draft_id, body, created_at FROM draft_feedback WHERE slot_id = ? ORDER BY created_at ASC`)
    .all(slotId) as FeedbackRow[];
}

// Top rules for a slot: exact scope first, then pillar-only / type-only,
// then global; ties break by use count, then newest. Bumps uses on the
// returned rows so the repo learns which rules earn their place.
export function rulesFor(
  pillarId: string | null,
  contentType: string | null,
  limit = 3,
): StyleRule[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, pillar_id, content_type, rule, uses FROM style_rules
       WHERE (pillar_id IS NULL OR pillar_id = ?) AND (content_type IS NULL OR content_type = ?)
       ORDER BY
         (CASE WHEN pillar_id IS NOT NULL THEN 2 ELSE 0 END +
          CASE WHEN content_type IS NOT NULL THEN 1 ELSE 0 END) DESC,
         uses DESC, created_at DESC
       LIMIT ?`,
    )
    .all(pillarId, contentType, limit) as StyleRule[];
  if (rows.length > 0) {
    const bump = db.prepare(`UPDATE style_rules SET uses = uses + 1 WHERE id = ?`);
    for (const r of rows) bump.run(r.id);
  }
  return rows;
}

function normalizeRule(rule: string): string {
  return rule.trim().toLowerCase().replace(/\s+/g, " ");
}

// Insert rules the repo doesn't already hold in the same scope. Returns the
// number actually added.
export function upsertRules(
  pillarId: string | null,
  contentType: string | null,
  rules: string[],
): number {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT rule FROM style_rules
       WHERE (pillar_id IS NULL OR pillar_id = ?) AND (content_type IS NULL OR content_type = ?)`,
    )
    .all(pillarId, contentType) as Array<{ rule: string }>;
  const seen = new Set(existing.map((r) => normalizeRule(r.rule)));
  const insert = db.prepare(
    `INSERT INTO style_rules (id, pillar_id, content_type, rule, uses, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
  );
  let added = 0;
  for (const rule of rules) {
    const text = rule.trim().slice(0, 300);
    if (!text || seen.has(normalizeRule(text))) continue;
    seen.add(normalizeRule(text));
    insert.run(randomUUID(), pillarId, contentType, text, nowIso());
    added++;
  }
  return added;
}

// Strict distill prompt: durable, non-obvious rules only, else []. This is
// the anti-bloat valve — most feedback compresses to zero rules.
export function buildDistillInput(
  feedback: string[],
  pillarName: string | null,
  contentType: string,
): string {
  return `You maintain a creator's style rules. Read the REVISION FEEDBACK below (notes the creator gave while revising one ${contentType} draft${pillarName ? ` on "${pillarName}"` : ""}) and extract durable style rules for future drafts.

Rules for your answer:
- Respond with ONLY a JSON object like {"rules": ["Never open with a question."]}, no prose.
- At most 2 rules. Prefer 0-1.
- A rule must be DURABLE (applies to future posts, not this one) and NON-OBVIOUS (never restate generic advice like "be clear" or "use hooks").
- One sentence each, imperative voice.
- If nothing qualifies, respond with exactly: {"rules": []}

REVISION FEEDBACK:
${feedback.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;
}

function asRules(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((r): r is string => typeof r === "string" && r.trim().length > 0).slice(0, 2);
}

export function parseRulesJson(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return asRules(parsed);
    if (typeof parsed === "object" && parsed !== null) {
      return asRules((parsed as Record<string, unknown>).rules);
    }
    return [];
  } catch {
    /* fall through to the hardened scan */
  }
  try {
    return asRules(extractJson(text, "distill").rules);
  } catch {
    return [];
  }
}

// Compress one slot's feedback into repo rules. No feedback → no call.
// Returns the number of rules added.
export async function distillSlotFeedback(slotId: string): Promise<number> {
  const db = getDb();
  const rows = feedbackForSlot(slotId);
  if (rows.length === 0) return 0;
  const slot = db
    .prepare(
      `SELECT s.pillar_id, p.name AS pillar_name, s.content_type
       FROM queue_slots s LEFT JOIN pillars p ON p.id = s.pillar_id WHERE s.id = ?`,
    )
    .get(slotId) as { pillar_id: string | null; pillar_name: string | null; content_type: string } | undefined;
  if (!slot) return 0;
  const metaKey = loadKeys().meta;
  if (!metaKey) throw new Error("save a Meta key in Settings first");
  const client = getMetaClient(metaKey);
  const input = buildDistillInput(
    rows.map((r) => r.body),
    slot.pillar_name,
    slot.content_type,
  );
  // Low effort + a roomy cap: the model can spend ~800 tokens reasoning on
  // even a tiny prompt, and a tight budget returns status incomplete with
  // zero text (probed live). Retry once; feedback rows persist anyway.
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await client.responses.create(
      {
        model: metaTextModel(),
        input,
        max_output_tokens: 8000,
        reasoning: { effort: "low" },
      },
      { timeout: 120000 },
    );
    if (!outputUsable(resp)) continue;
    const rules = parseRulesJson((resp.output_text as string).trim());
    if (rules.length === 0) return 0;
    return upsertRules(slot.pillar_id, slot.content_type, rules);
  }
  return 0;
}
