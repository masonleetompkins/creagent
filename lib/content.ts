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
