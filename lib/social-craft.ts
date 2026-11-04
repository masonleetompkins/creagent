// Post craft: ranked, platform-specific drafting rules. The X block is
// grounded in X's open-sourced heavy-ranker README (last published weights,
// April 2023): reply 13.5, author-engaged reply 75.0, convo open 11.0,
// 2-min dwell 10.0, repost 1.0, like 0.5, negative -74, report -369; the
// model also sees explicit link/media/hashtag/mention/dwell features.
// The Threads block comes from the creator's own knowledge base.
import { THREAD_KINDS } from "./content";
const X_CRAFT = `POST CRAFT (from X's open-sourced ranker — design for the top of this list):
1. Replies rule (27x a like): end with ONE answerable question, take-a-side, or fill-in-the-blank. No post without a reply trigger.
2. Earn the tap and the dwell: the first 40 characters must open a curiosity gap the rest pays off. Never trick — misleading hooks earn blocks and reports, the most negative signals in the model.
3. Repostable identity (2x a like): state it so followers repost to signal tribe — sharp, quotable, no hedging.
4. One idea, zero friction: no bare links in the post body, max 1 hashtag, no @mentions unless earned. Links, hashtags, and mentions are explicit ranker features — each one is a tax.
5. Built for the reply-back: invite answers you can riff on in the comments. Author-engaged replies are the single biggest signal (150x a like).`;

const THREADS_CRAFT = `POST CRAFT (Threads): one poignant idea, text-only — images and video underperform on Threads. End with an answerable question or a gentle take-a-side; Threads rewards kind discussion, not dunking. No links in the body.`;

export function craftBlock(platforms: string[], kind: string): string {
  if (kind !== "short_post" && !THREAD_KINDS.has(kind)) return "";
  const blocks: string[] = [];
  if (platforms.includes("x")) blocks.push(X_CRAFT);
  if (platforms.includes("threads")) blocks.push(THREADS_CRAFT);
  return blocks.join("\n\n");
}
