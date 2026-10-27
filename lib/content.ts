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

export function isContentType(value: string): value is ContentType {
  return value in CONTENT_TYPES;
}

// Platform playbook: the per-type production guide the agent drafts from.
// Shared with the Brain page so the user sees the same instructions.
export const PLAYBOOK: Record<string, string> = {
  short_post: "Write one punchy post under 280 characters, plus two alternate variants below it.",
  thread: "Write a 6-9 post thread. Number each post, keep each under 280 characters, open with a hook and end with a takeaway or question.",
  video_trend: "Write a short-form video script: HOOK (first 2 seconds), 3-5 beats with what to say and show, and a CTA. Keep it under 45 seconds spoken.",
  video_series: "Write an episode script for a recurring series: cold open that states the series premise in one line, the episode content in beats, and a consistent sign-off.",
  video_yap: "Write a talking-head script: strong opinion hook, 3 supporting points in conversational spoken language, and a closer. Under 60 seconds spoken.",
  carousel: "Write slide-by-slide copy for a 7-slide carousel: cover hook, one idea per slide in 2 lines or less, and a final CTA slide.",
  article_blog: "Write a 600-900 word blog post with a headline, short intro, 3-4 headed sections, and a closing takeaway.",
  article_thread: "Write a long-form thread version of an article: headline post plus 8-12 numbered posts covering intro, key sections, and takeaway.",
  long_video: "Write a long-form video outline and script: title options, hook, chapter-by-chapter talking points with stories/examples, and an end screen CTA.",
  clip: "Write a clip package from a long video: the clip's hook line, the 30-60 second segment to cut, on-screen caption text, and a post caption.",
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
  "blog",
] as const;

export type SlotStatus = "red" | "orange" | "green" | "gray";

export function isSlotStatus(value: string): value is SlotStatus {
  return value === "red" || value === "orange" || value === "green" || value === "gray";
}
