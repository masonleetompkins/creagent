// Idea-first drafting: reason UP from the data to a fresh angle before
// writing. Each fresh draft gets one assigned idea that must differ from
// everything covered recently — new ideas in proven formats, or proven
// ideas in fresh formats — written for the target reader. Plain text
// throughout: an unparseable idea just means drafting proceeds as before.
import { getAudience } from "./brain";
import { getDb } from "./db";

export const IDEA_TEMPERATURE = 1.2;

export type CoveredTopic = { pillar: string; kind: string; excerpt: string };

// What the queue already covered: recent drafts (newest first), bounded
// excerpts. The drafting slot's own versions are excluded by the caller —
// a redraft must stay on its topic, not flee from it.
export function recentDraftTopics(
  excludeSlotId: string | null,
  days = 14,
  limit = 12,
): CoveredTopic[] {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT p.name AS pillar, d.kind, d.body, d.created_at
       FROM drafts d JOIN queue_slots s ON s.id = d.slot_id
       LEFT JOIN pillars p ON p.id = s.pillar_id
       WHERE d.created_at >= ? AND (? IS NULL OR d.slot_id != ?)
       ORDER BY d.created_at DESC LIMIT 200`,
    )
    .all(since, excludeSlotId, excludeSlotId) as Array<{
    pillar: string | null;
    kind: string;
    body: string;
    created_at: string;
  }>;
  return rows.slice(0, limit).map((r) => ({
    pillar: r.pillar ?? "(no pillar)",
    kind: r.kind,
    excerpt: r.body.replace(/\s+/g, " ").trim().slice(0, 160),
  }));
}

export function buildFreshnessSection(topics: CoveredTopic[]): string {
  if (topics.length === 0) return "";
  const lines = [
    "ALREADY COVERED (your drafts from the last 14 days — do not rehash these topics):",
  ];
  for (const t of topics) {
    lines.push(`- [${t.pillar} / ${t.kind}] ${t.excerpt}`);
  }
  return lines.join("\n");
}

export function buildAudienceSection(): string {
  const audience = getAudience();
  if (!audience || !audience.body.trim()) {
    return "TARGET READER: (no audience profile yet — infer the reader from the pillar and voice, and write for them, not for yourself)";
  }
  return `TARGET READER (every idea must earn this person's attention):\n${audience.body.trim().slice(0, 1500)}`;
}

export type IdeaContext = {
  pillarLine: string;
  typeLabel: string;
  platformsLine: string;
  pillarSection: string;
  vaultContext: string;
  newsSection: string;
  freshnessSection: string;
  audienceSection: string;
  dumpSection?: string;
};

// The reasoning step: data in (proven formats, proven ideas, news, reader,
// covered list), one fresh idea out. The FORMAT MOVE line is the heart of
// it — borrow a winner's shape for a new thought, or pour a winner's
// thought into a shape it hasn't worn yet.
export function buildIdeaPrompt(ctx: IdeaContext): string {
  const proven = ctx.pillarSection ? `\n\n${ctx.pillarSection}` : "";
  const vault = `\n\nVAULT (your proven ideas, principles, quotes):\n${ctx.vaultContext}`;
  const covered = ctx.freshnessSection ? `\n\n${ctx.freshnessSection}` : "";
  const dump = ctx.dumpSection ? `\n\n${ctx.dumpSection}` : "";
  return `You are the creator's ideas editor. Pick ONE fresh angle for the next piece.
${dump}
${ctx.audienceSection}

${ctx.pillarLine}
Content type: ${ctx.typeLabel}
Platforms: ${ctx.platformsLine}${proven}${ctx.newsSection}${vault}${covered}

Rules:
- The idea must be new: not in ALREADY COVERED above, and not a rephrase of anything there. Current beats evergreen — if the news names a live debate, number, or launch, hook the idea to it.
- Package it deliberately: either a NEW idea in one of the proven formats above, or a proven idea from the vault in a format it hasn't worn yet. Name the move.
- Keep the target reader in mind: the idea must matter to them next week, not just sound smart today.
- One idea only. Reply in exactly this shape, no preamble:
IDEA: <one vivid sentence — the post's point>
FORMAT MOVE: <which proven format it borrows, or the fresh format it tries>
WHY NEW: <one line on how it differs from ALREADY COVERED>`;
}

export type ParsedIdea = { idea: string; formatMove: string; whyNew: string };

export function parseIdea(text: string): ParsedIdea | null {
  const idea = text.match(/^\s*idea\s*:\s*(.+)$/im)?.[1]?.trim();
  if (!idea) return null;
  const formatMove = text.match(/^\s*format\s+move\s*:\s*(.+)$/im)?.[1]?.trim() ?? "";
  const whyNew = text.match(/^\s*why\s+new\s*:\s*(.+)$/im)?.[1]?.trim() ?? "";
  return { idea, formatMove, whyNew };
}

export function buildIdeaSection(parsed: ParsedIdea): string {
  const move = parsed.formatMove ? `\nFormat move: ${parsed.formatMove}` : "";
  const why = parsed.whyNew ? `\nWhy new: ${parsed.whyNew}` : "";
  return `ASSIGNED IDEA (write THIS angle — do not invent a different topic):\n${parsed.idea}${move}${why}`;
}

// One ideation call with one empty-retry. The caller injects its text
// caller (drafting's callText) so this module stays dependency-free.
// Returns null on empty/unparseable/error — drafting proceeds without one.
export async function ideate(
  call: (prompt: string, temperature?: number) => Promise<string>,
  prompt: string,
): Promise<ParsedIdea | null> {
  try {
    let text = (await call(prompt, IDEA_TEMPERATURE)).trim();
    if (!text) text = (await call(`${prompt}\n\nYour previous response was empty. Reply now.`, IDEA_TEMPERATURE)).trim();
    return text ? parseIdea(text) : null;
  } catch {
    return null;
  }
}
