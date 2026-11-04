// Shared content taxonomy. Pure data: safe to import from client components.
export const CONTENT_TYPES = {
  short_post: { label: "Short post", hint: "X / Threads / Facebook" },
  thread: { label: "Thread", hint: "X / Threads" },
  video_trend: { label: "Video trend", hint: "Shorts / Reels / TikTok" },
  video_series: { label: "Video series", hint: "Shorts / Reels / TikTok" },
  video_yap: { label: "Video yap", hint: "Shorts / Reels / TikTok" },
  carousel: { label: "Carousel", hint: "Instagram / TikTok / Facebook" },
  article_blog: { label: "Article (blog)", hint: "Blog / LinkedIn" },
  article_thread: { label: "Article (thread)", hint: "X / Threads" },
  long_video: { label: "Long video", hint: "YouTube / X / Facebook" },
  clip: { label: "Clip", hint: "Cut from long video, all platforms" },
} as const;

export type ContentType = keyof typeof CONTENT_TYPES;

// Kinds that fan out as hook options + thread body (shared by drafting,
// craft, banking, publishing, and the UI).
export const THREAD_KINDS: ReadonlySet<string> = new Set(["thread", "article_thread"]);

// Media kinds: carousel ships slide images, video kinds ship one finished
// file. Both carry a separate post-caption block alongside the draft.
export const IMAGE_KINDS: ReadonlySet<string> = new Set(["carousel"]);
export const VIDEO_KINDS: ReadonlySet<string> = new Set([
  "video_trend",
  "video_series",
  "video_yap",
  "long_video",
  "clip",
]);

export function isContentType(value: string): value is ContentType {
  return value in CONTENT_TYPES;
}

// Platform playbook: the per-type production guide the agent drafts from.
// Shared with the Brain page so the user sees the same instructions.
export const PLAYBOOK: Record<string, string> = {
  short_post: "Write exactly one standalone post about ONE idea only — if two ideas compete, cut the weaker half. Hard limit 280 characters. Never a thread hook: no numbered parts, no 'thread below', no 'everything interesting' roundup openers. Output only the post, no preamble, no variants.",
  thread:
    "Write thread posts 2 through N (6-9 posts total including the hook above — do NOT write the hook). One point per post, each post opening connected to the previous (because / so / then / but / now) — never a list of standalone takes. Number each post like 1/ 2/ 3/, keep each under 280 characters, end with a takeaway or a reply-bait question. Output only the posts, blank line between them.",
  video_trend:
    "Write a short-form video script as spoken lines the creator reads to camera, under 45 seconds. Architecture: HOOK in the first 2 seconds (bold claim or open loop — no greeting, no setup); 3-5 beats where each beat pays off a piece of the loop AND opens the next, with [SHOW: what is on screen] per beat; final payoff that lands the hook's promise; one CTA. Cut every line that doesn't earn the next 3 seconds — no throat-clearing, no recaps.",
  video_series:
    "Write an episode script for a recurring series as spoken lines. Cold open states the series premise in ONE line (returning viewers nod, new viewers are oriented), then the episode hook. 3-5 beats, each opening connected to the last and each earning the next 3 seconds, with [SHOW: what is on screen] per beat. Payoff, then the consistent sign-off verbatim. Same skeleton every episode, all-new content inside it.",
  video_yap:
    "Write a talking-head script as spoken lines, under 60 seconds, in conversational spoken language (contractions, fragments, interruptions — nothing that reads like an essay). Strong opinion hook in 2 seconds; 3 supporting points ordered weakest-to-strongest, each connected to the last with a spoken bridge ('and here's the part nobody mentions'); closer that restates the opinion sharper than the hook. One idea only — cut the weaker half if two compete.",
  carousel:
    "Write a 7-slide carousel as ONE continuous story, not seven statements. Caption first (hook + question + 2-3 hashtags), then SLIDE 1..7 markers, 2 lines or less per slide. Architecture: cover hook that opens a loop; ONE running scene or analogy that carries every slide; each slide opens by connecting to the previous slide (because / so / then / now / but) or calls back to the opening scene; a name-the-concept bridge mid-way ('This is what adults call X' / 'What you just did is called X'); 2-3 applications that map back onto the SAME frame; payoff plus a comment CTA. Never: disconnected slides, a restated definition per slide, or a new unrelated scene per slide. The reader must feel pulled forward — every slide earns the next.",
  article_blog:
    "Write a 600-900 word blog post. Cold open: first paragraph drops the reader into a scene, number, or claim — no throat-clearing, no 'in today's world'. Thesis by paragraph two. 3-4 headed sections, each opening with its point (no burying), each handing off to the next with a forward reference; stories and concrete examples beat abstractions. Closing takeaway the reader can act on this week, plus one CTA. Sound like the voice exemplars, not a help article.",
  article_thread:
    "Write thread posts 2 through N (10-14 posts total including the hook above — do NOT write the hook). Cover intro, key sections in order, and takeaway: one point per post, each post opening connected to the previous (because / so / then / but / now). Number each post like 1/ 2/ 3/, keep each under 280 characters, end with the takeaway plus a reply-bait question. Output only the posts, blank line between them.",
  long_video:
    "Write a long-form video package: 3 title options, a 15-second hook (promise + open loop + credibility in one breath), then chapter-by-chapter talking points. Each chapter opens with its own micro-hook, carries one story or example, and ends on an open loop into the next chapter — no recaps, no 'smash subscribe' before the payoff. End screen CTA after the final payoff only.",
  clip: "Write a clip package from a long video: the clip's hook line (first 2 seconds, must work with sound off), the 30-60 second segment to cut with IN/OUT timecodes and why this moment pops out of context, word-for-word on-screen caption text with EMPHASIS words marked, and a post caption ending in a reply-bait question.",
};

// Platform guides: distilled from the creator's Social Media Knowledge
// Base. Per-platform hook rules, formats, and ranked leading indicators.
// The agent reads these via brain_overview; the Brain page shows them.
export const PLATFORM_GUIDES: Record<string, { label: string; guide: string }> = {
  linkedin: {
    label: "LinkedIn",
    guide:
      "Hook cut off after 140 characters; the hook is the first 2 lines plus the image. Max 3,000 characters. Image hooks beat text-only. The hook must be shareable AND the post must deliver deep value. Connections matter more than followers (1st/2nd/3rd-degree amplification). Most impressions land in the first 12 hours, trailing 3-5 days; low reposts means almost nothing after 24h. Leading indicators, ranked: taps (unreported), time spent (unreported), reposts, comments, likes.",
  },
  facebook: {
    label: "Facebook",
    guide:
      "Written hook cut off after 40 characters. Long-form written posts in the home feed are the historic top performers; hook is 1 setup line plus an image (top 4 written posts all had hook images). Links/CTAs at post time carry no penalty. Reels show 4:5 in feed; first 3 seconds + retention graph decide; over 3 minutes gets less recommendation. Views peak 20-30h after posting, meaningful distribution up to 7 days; exceptional videos can resurface months later. Video leading indicators: 50%+ retention intervals, reposts, comments, reactions. Written leading indicators: reposts, link clicks, comments, reactions.",
  },
  instagram: {
    label: "Instagram",
    guide:
      "Written hook cut off after 40 characters. Reels (vertical, under 3m) get an even follower/non-follower test of ~1% of followers at post; good thumbnails and big clear subtitles help Explore. Carousels with music distribute as Reels but rarely surface in the Reels tab. Carousels/photo posts test to existing audience first; shares drive non-follower distribution. Carousel/photo indicators: shares, comments, likes, saves. Reel indicators: 3s views (hook quality), average view duration, shares, comments, likes, saves.",
  },
  x: {
    label: "X",
    guide:
      "Tweet text cut off after 257 characters. Audience skews conservative and aggressive (vs kind/supportive Threads). Long-form wins: multi-part threads and single long-form tweets; video only breaks through on timely political news. Proven thread format: 4-line hook + hook image, 3 media posts (usually explainer video), 3-5 text posts; lead-to-CTA retention runs 2-10%. Leading indicators: reposts, replies, shares, likes.",
  },
  threads: {
    label: "Threads",
    guide:
      "Image and video posts have not performed; text-only single posts with one poignant idea perform very well. Long-form thread format mirrors X (4-line hook + image, 3 media posts, 3-5 text posts) with 2-5% lead-to-CTA retention. Leading indicators: taps (unreported), time spent (unreported), shares, comments, likes.",
  },
  tiktok: {
    label: "TikTok",
    guide:
      "Performance = hook stopping power + retention-graph depth. High AVD is necessary but not sufficient; what matters is seconds retaining 50%+ of viewers. Shares and comments are the best leading indicators. Ranked: 50%+ retention seconds, shares, comments, likes.",
  },
  youtube_shorts: {
    label: "YouTube Shorts",
    guide:
      "Titles categorize the video for initial audiences. Headline drives CTR more than thumbnail text, but a weak thumbnail still kills the scroll. The hook must pay off the thumbnail+headline or viewers feel tricked and scroll; in the Shorts feed the hook comes before headline/thumbnail. Great hook: emotionally provocative statement in 2s (3-5s if the first 2 land) with a curiosity gap. Every 3-5s statement must earn the next 3-5s. Ranked indicators: stayed-to-watch >70%, CTR, avg view % 90-120%, 50+ shares, 100+ comments, 2000+ likes.",
  },
  youtube_community: {
    label: "YouTube Community",
    guide:
      "Written hook cut off after 60 characters; consumed in the Home feed. Scroll-stopper image with a clear point of interest + 1-line written hook. 'See More' taps count toward distribution; longer posts beat short captions. Link clicks outweigh likes for performance. Polls work only with emotional votes plus strong likes/comments. Ranked indicators: 'See More' taps, link clicks, likes, comments, votes.",
  },
};

export const PLATFORMS = [
  "x",
  "threads",
  "facebook",
  "instagram",
  "tiktok",
  "youtube",
  "linkedin",
] as const;

// Single-post character caps from Zernio's platform docs. Shared by the
// publish preflight and the inspector's live count — one source of truth.
export const PLATFORM_POST_CAPS: Record<string, number> = {
  x: 280,
  threads: 500,
  linkedin: 3000,
  instagram: 2200,
  facebook: 63206,
};

export type SlotStatus = "red" | "orange" | "green" | "gray";

export function isSlotStatus(value: string): value is SlotStatus {
  return value === "red" || value === "orange" || value === "green" || value === "gray";
}
