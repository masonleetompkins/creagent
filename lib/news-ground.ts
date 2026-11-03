// Live news grounding for news pillars: fetch today's drops via Brave so
// drafts cite real items instead of inventing them. Query derivation is
// deterministic (generic tokens stripped from the pillar name); failures
// degrade to an evergreen-only instruction, never a failed draft.
import { braveWebSearch } from "./brave";

const GENERIC_TOKENS = new Set(
  ["news", "roundup", "round-up", "daily", "weekly", "update", "updates", "drops", "drop", "thread", "threads", "briefing", "recap"].map((w) => w.toLowerCase()),
);

const NEWSY = /news|roundup|round-up|drops|\bbriefing\b/i;

export function needsNews(pillarName: string | null, pillarDesc: string | null): boolean {
  if (!pillarName) return false;
  return NEWSY.test(pillarName) || NEWSY.test(pillarDesc ?? "");
}

export function newsTopic(pillarName: string): string {
  const core = pillarName
    .split(/\s+/)
    .filter((w) => w && !GENERIC_TOKENS.has(w.toLowerCase()))
    .join(" ")
    .trim();
  return core || pillarName.trim();
}

export function newsQueries(pillarName: string): string[] {
  const topic = newsTopic(pillarName);
  return [`${topic} news today`, `latest ${topic} announcements`];
}

export type NewsItem = { title: string; snippet: string; age: string | null };

type BraveResult = {
  title?: unknown;
  description?: unknown;
  age?: unknown;
};

function cleanSnippet(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

export function parseNewsResults(data: unknown, limit = 6): NewsItem[] {
  const results = (data as { web?: { results?: unknown } })?.web?.results;
  if (!Array.isArray(results)) return [];
  const out: NewsItem[] = [];
  for (const r of results as BraveResult[]) {
    if (out.length >= limit) break;
    const title = typeof r.title === "string" ? r.title.replace(/\s+/g, " ").trim() : "";
    if (!title) continue;
    out.push({
      title: title.slice(0, 140),
      snippet: typeof r.description === "string" ? cleanSnippet(r.description) : "",
      age: typeof r.age === "string" ? r.age : null,
    });
  }
  return out;
}

export async function fetchNews(apiKey: string, pillarName: string): Promise<NewsItem[]> {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const q of newsQueries(pillarName)) {
    const items = parseNewsResults(await braveWebSearch(apiKey, q, 5));
    for (const item of items) {
      const key = item.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= 6) return out;
    }
  }
  return out;
}

export function buildNewsSection(items: NewsItem[]): string {
  if (items.length === 0) {
    return "(live news unavailable — write evergreen angles only, invent no specifics)";
  }
  const lines = [
    "LIVE NEWS (fetched today — every specific claim below must trace here or to the vault; never invent drops, stats, dates, or quotes):",
  ];
  for (const item of items) {
    lines.push(`- ${item.title}${item.snippet ? ` — ${item.snippet}` : ""}${item.age ? ` [${item.age}]` : ""}`);
  }
  const section = lines.join("\n");
  return section.length > 1500 ? `${section.slice(0, 1500)}…[truncated]` : section;
}
