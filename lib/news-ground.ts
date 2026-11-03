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

export type BraveResult = {
  title?: unknown;
  description?: unknown;
  age?: unknown;
  url?: unknown;
};

// Specificity ranking, in code: concrete stories outrank section fronts.
// Snippets with numbers/names ground real claims; category roots ("…/ai/",
// "…/topics/…") rarely carry specifics.
export function rankNewsResults(results: BraveResult[]): BraveResult[] {
  const score = (r: BraveResult): number => {
    let s = 0;
    const text = `${typeof r.title === "string" ? r.title : ""} ${typeof r.description === "string" ? r.description : ""}`;
    if (/\d/.test(text)) s += 2;
    if (text.length > 120) s += 1;
    if (/["“”]/.test(text)) s += 1;
    const url = typeof r.url === "string" ? r.url : "";
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (/\/(category|topic|topics|latest|news)\b/i.test(path)) s -= 2;
    if ((path.match(/\//g) ?? []).length <= 1) s -= 1;
    return s;
  };
  return [...results].sort((a, b) => score(b) - score(a));
}

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
  for (const r of rankNewsResults(results as BraveResult[])) {
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
    const items = parseNewsResults(await braveWebSearch(apiKey, q, 8));
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
    "COMPLETENESS: a finished news post names WHAT (model/product/company), one KEY NUMBER (price, params, speed, date), and WHY IT MATTERS (one line). If the news lacks one, write around it — never pad with vagueness.",
  ];
  for (const item of items) {
    lines.push(`- ${item.title}${item.snippet ? ` — ${item.snippet}` : ""}${item.age ? ` [${item.age}]` : ""}`);
  }
  const section = lines.join("\n");
  return section.length > 1500 ? `${section.slice(0, 1500)}…[truncated]` : section;
}
