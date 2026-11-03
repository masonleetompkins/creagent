// Platform fit: what the draft prompt needs to stop writing ELI5 posts for
// platforms where ELI5 never performed. Per target platform: this pillar's
// measured multiple, the platform's native winners, and the distilled
// platform rules from the knowledge base. Bounded — a few hundred chars
// per platform, at most 3 platforms per slot.
import { PLATFORM_GUIDES } from "./content";
import { getDb } from "./db";
import { pillarStats, platformForSource } from "./metrics";

const VIDEO_TYPES = new Set(["video_trend", "video_series", "video_yap", "long_video", "clip"]);

const PLATFORM_LABELS: Record<string, string> = {
  x: "X",
  threads: "Threads",
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  blog: "Blog",
};

function guideKey(platform: string, contentType: string): string | null {
  if (platform === "youtube") return VIDEO_TYPES.has(contentType) ? "youtube_shorts" : "youtube_community";
  if (platform === "blog" || platform === "other") return null;
  return PLATFORM_GUIDES[platform] ? platform : null;
}

export type PlatformWinner = { title: string; multiple: number };

export type PlatformFit = {
  platform: string;
  label: string;
  pillarPosts: number;
  pillarMultiple: number | null;
  guide: string | null;
  winners: PlatformWinner[];
};

function trimText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function winnersByPlatform(): Map<string, PlatformWinner[]> {
  const rows = getDb()
    .prepare(
      `SELECT source, title, transcript, multiplier FROM assets
       WHERE is_reply = 0 AND multiplier IS NOT NULL`,
    )
    .all() as Array<{
    source: string;
    title: string | null;
    transcript: string | null;
    multiplier: number;
  }>;
  const byPlatform = new Map<string, PlatformWinner[]>();
  for (const row of rows) {
    const platform = platformForSource(row.source);
    if (platform === "other") continue;
    const title = trimText(row.title ?? row.transcript ?? "", 90) || "(untitled post)";
    const list = byPlatform.get(platform) ?? [];
    list.push({ title, multiple: row.multiplier });
    byPlatform.set(platform, list);
  }
  for (const [platform, list] of byPlatform) {
    list.sort((a, b) => b.multiple - a.multiple);
    byPlatform.set(platform, list.slice(0, 2));
  }
  return byPlatform;
}

export function parseSlotPlatforms(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function platformFitFor(
  pillarId: string | null,
  platforms: string[],
  contentType: string,
): PlatformFit[] {
  const stats = pillarId ? (pillarStats()[pillarId] ?? null) : null;
  const winners = winnersByPlatform();
  const fits: PlatformFit[] = [];
  for (const platform of platforms.slice(0, 3)) {
    const key = guideKey(platform, contentType);
    const stat = stats?.byPlatform[platform];
    const guide = key ? trimText(PLATFORM_GUIDES[key].guide, 400) : null;
    const list = winners.get(platform) ?? [];
    // Skip platforms we know nothing about — no stats, no winners, no guide.
    if (!stat && list.length === 0 && !guide) continue;
    fits.push({
      platform,
      label: PLATFORM_LABELS[platform] ?? platform,
      pillarPosts: stat?.posts ?? 0,
      pillarMultiple: stat?.multiplier ?? null,
      guide,
      winners: list,
    });
  }
  return fits;
}

export function isWeakFit(fit: PlatformFit): boolean {
  return fit.pillarMultiple !== null && fit.pillarPosts > 0 && fit.pillarMultiple < 0.7;
}

function verdict(fit: PlatformFit): string {
  const m = fit.pillarMultiple;
  if (m === null || fit.pillarPosts === 0) return "no scored history — follow the platform rules and winners below";
  if (m >= 1.2) return `strong fit (${m}x your ${fit.label} median across ${fit.pillarPosts} posts)`;
  if (m >= 0.7) return `mixed fit (${m}x your ${fit.label} median across ${fit.pillarPosts} posts)`;
  return `WEAK FIT (${m}x your ${fit.label} median across ${fit.pillarPosts} posts) — open and structure this draft like the winners above, not like your usual posts`;
}

export function buildFitSection(
  fits: PlatformFit[],
  pillarName: string | null,
): string {
  if (fits.length === 0) return "";
  const pillar = pillarName ? `"${pillarName}"` : "this pillar";
  const lines = ["PLATFORM FIT (your measured results — a WEAK FIT here overrides voice-profile habits for this draft):"];
  for (const fit of fits) {
    lines.push(`- ${fit.label}: ${pillar} — ${verdict(fit)}.`);
    if (fit.winners.length > 0) {
      lines.push(
        `  Your top ${fit.label} posts: ${fit.winners.map((w) => `"${w.title}" (${w.multiple}x)`).join("; ")}.`,
      );
    }
    if (fit.guide) lines.push(`  ${fit.label} rules: ${fit.guide}`);
  }
  return lines.join("\n");
}
