// Taste controls: push drafts off the internet-mean. Full-voice exemplars
// (verbatim winners, not trimmed stubs), negative anti-slop constraints,
// and a text-based critic pass. No JSON anywhere — every failure mode
// keeps the original text.
import { getDb } from "./db";
import { platformForSource } from "./metrics";

// Fires on every fan-out prompt, right after the vault context (recency).
// Bans the tells that mark averaged-out model prose.
export const ANTI_SLOP = `TASTE RULES (a draft breaking any of these fails):
- Banned words: delve, tapestry, landscape, game-changer, unlock, supercharge, elevate, "dive in", "unpack", "it's not X, it's Y".
- Banned openers: "In today's…", "Let's be honest", "Hot take:", "Unpopular opinion:", any dictionary definition.
- No stacked rhetorical questions, no hashtag piles, no emoji piles.
- One idea per post. Ship the sharp version, not the hedged one — cut "might", "could", "arguably", "in some ways".
- Match the voice exemplars' cadence and bluntness. Zero corporate polish.`;

// Full verbatim winners for voice matching: pillarExemplars' 120-char stubs
// teach format, these teach diction. Platform-preferred, backfilled
// pillar-wide, each post bounded so two winners can't swallow the prompt.
export type VoiceExemplar = { body: string; multiple: number; platform: string };

export function pillarVoiceExemplars(
  pillarId: string | null,
  platforms: string[],
  limit = 2,
  maxChars = 600,
): VoiceExemplar[] {
  if (!pillarId) return [];
  const rows = getDb()
    .prepare(
      `SELECT source, title, transcript, multiplier FROM assets
       WHERE pillar_id = ? AND is_reply = 0 AND multiplier IS NOT NULL
       ORDER BY multiplier DESC LIMIT 25`,
    )
    .all(pillarId) as Array<{
    source: string;
    title: string | null;
    transcript: string | null;
    multiplier: number;
  }>;
  const mapped: VoiceExemplar[] = [];
  for (const r of rows) {
    const text = [r.title, r.transcript].filter((t) => t && t.trim()).join("\n");
    if (!text.trim()) continue;
    mapped.push({
      body: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text,
      multiple: r.multiplier,
      platform: platformForSource(r.source),
    });
  }
  const preferred = mapped.filter((m) => platforms.includes(m.platform));
  const rest = mapped.filter((m) => !platforms.includes(m.platform));
  return [...preferred, ...rest].slice(0, limit);
}

// Long kinds need full winner arcs, not openings: a 600-char cut hides the
// bridge, the ladder, and the payoff — the exact architecture the model
// must imitate. Short kinds keep the tight budget.
const LONG_KINDS = new Set([
  "carousel",
  "video_trend",
  "video_series",
  "video_yap",
  "long_video",
  "clip",
  "article_blog",
  "article_thread",
]);

export function exemplarBudgetFor(kind: string): number {
  return LONG_KINDS.has(kind) ? 1500 : 600;
}

export function buildVoiceExemplarSection(
  pillarId: string | null,
  pillarName: string | null,
  platforms: string[],
  maxChars = 600,
): string {
  if (!pillarId || !pillarName) return "";
  const exemplars = pillarVoiceExemplars(pillarId, platforms, 2, maxChars);
  if (exemplars.length === 0) return "";
  const lines = [
    `VOICE EXEMPLARS ("${pillarName}" — your own verbatim winners. Match this cadence and diction exactly):`,
  ];
  for (const e of exemplars) {
    lines.push(`--- (${e.multiple}x${e.platform !== "other" ? `, ${e.platform}` : ""})\n${e.body}`);
  }
  return lines.join("\n");
}

// Critic pass: score ORIGINALITY + voice match 1–5, rewrite at 3 or below.
// The score line is machine-read (regex, first line); the rewrite is the
// human-readable remainder. Unparseable verdicts keep the original.
export const CRITIC_THRESHOLD = 3;

export function buildCriticPrompt(draft: string): string {
  return `You are a ruthless social-media editor scoring ONE draft post for ORIGINALITY + voice match, 1-5:
1 = generic AI slop anyone could write; 3 = competent but safe; 5 = sharp, specific, unmistakably this creator.

${ANTI_SLOP}

DRAFT TO SCORE:
${draft}

First line of your reply: SCORE: n/5
Score 4+ and stop there. Score 3 or lower, then add a blank line and the full rewritten post — same idea and facts, sharper voice, obeying every taste rule. Output only the score line and (when rewriting) the post.`;
}

export function parseCriticScore(verdict: string): number | null {
  const m = verdict.match(/^\s*score\s*:\s*([1-5])(?:\s*\/\s*5)?/im);
  return m ? Number.parseInt(m[1], 10) : null;
}

// Everything after the score line, when the critic chose to rewrite.
export function extractRevision(verdict: string): string | null {
  const lines = verdict.split("\n");
  const idx = lines.findIndex((l) => /^\s*score\s*:\s*[1-5](?:\s*\/\s*5)?/i.test(l));
  if (idx < 0) return null;
  const rest = lines
    .slice(idx + 1)
    .join("\n")
    .replace(/^["“]|["”]$/g, "")
    .trim();
  return rest ? rest : null;
}
