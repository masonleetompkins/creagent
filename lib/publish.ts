// Zernio publishing for green (approved) slots. USER-ONLY: no agent tool
// calls this module — the user clicks Post in the inspector, which is the
// approval. Preflight is all-or-nothing (every platform needs exactly one
// connected account and length-valid text) before anything is sent;
// per-platform receipts land in slot_posts; the slot flips gray only when
// every platform published. Docs: docs.zernio.com/posts/create-post
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";
import { resolveApproval } from "./draft-approval";
import { clampSelection, parseStructure, splitLegacyOptions } from "./draft-structure";
import { parseSlotPlatforms } from "./platform-fit";
import { zernioAccounts, zernioCreatePost, type ZernioAccount } from "./zernio";

// Our platform keys → Zernio platform slugs (docs.zernio.com/platforms).
// blog has no connected-account target and can't publish.
export const ZERNIO_SLUGS: Record<string, string> = {
  x: "twitter",
  threads: "threads",
  facebook: "facebook",
  instagram: "instagram",
  tiktok: "tiktok",
  youtube: "youtube",
  linkedin: "linkedin",
};

const THREAD_SLUGS = new Set(["twitter", "threads"]);
const THREAD_KINDS = new Set(["thread", "article_thread"]);
const TEXT_KINDS = new Set(["short_post", "thread", "article_thread"]);

// Length caps from Zernio's platform docs — their API rejects over these,
// so we preflight and fail before a multi-platform send can half-publish.
const SINGLE_CAPS: Record<string, number> = {
  twitter: 280,
  threads: 500,
  linkedin: 3000,
  instagram: 2200,
  facebook: 63206,
};
const THREAD_ITEM_CAPS: Record<string, number> = { twitter: 280, threads: 500 };

export type PublishText =
  | { mode: "single"; content: string }
  | { mode: "thread"; items: string[] };

export type PublishTarget = {
  platform: string;
  slug: string;
  accountId: string;
  username: string;
};

export type PlatformReceipt = {
  platform: string;
  username: string;
  payload: string;
  status: string;
  postUrl: string | null;
  error: string | null;
};

export type PublishResult =
  | { ok: true; postId: string | null; receipts: PlatformReceipt[]; slotStatus: string }
  | { ok: false; error: string; postId?: string | null; receipts?: PlatformReceipt[] };

export function splitThreadItems(hook: string, body: string): string[] {
  return [hook, ...body.split(/\n\s*\n/)]
    .map((p) => p.trim())
    .filter(Boolean);
}

function overCap(text: string, cap: number): boolean {
  return Array.from(text.trim()).length > cap;
}

// Pure body builder: thread-capable platforms get the sequence, every other
// platform gets the full text as one cross-post. Error or body, never both.
export function buildPublishBody(
  text: PublishText,
  targets: PublishTarget[],
): { body: Record<string, unknown>; payloads: Record<string, string> } | { error: string } {
  if (targets.length === 0) return { error: "no publish targets" };
  if (text.mode === "single") {
    for (const t of targets) {
      const cap = SINGLE_CAPS[t.slug];
      if (cap !== undefined && overCap(text.content, cap)) {
        return {
          error: `${t.platform} caps posts at ${cap} characters — this one is ${Array.from(text.content.trim()).length}. Shorten the draft, then post.`,
        };
      }
    }
    return {
      body: {
        content: text.content,
        platforms: targets.map((t) => ({ platform: t.slug, accountId: t.accountId })),
        publishNow: true,
      },
      payloads: Object.fromEntries(targets.map((t) => [t.platform, "post"])),
    };
  }
  const fullText = text.items.join("\n\n");
  const entries: Array<Record<string, unknown>> = [];
  const payloads: Record<string, string> = {};
  for (const t of targets) {
    if (THREAD_SLUGS.has(t.slug)) {
      const cap = THREAD_ITEM_CAPS[t.slug];
      const bad = text.items.findIndex((item) => cap !== undefined && overCap(item, cap));
      if (bad >= 0) {
        return {
          error: `${t.platform} caps thread posts at ${cap} characters — post ${bad + 1} is over. Shorten it, then post.`,
        };
      }
      entries.push({
        platform: t.slug,
        accountId: t.accountId,
        platformSpecificData: { threadItems: text.items.map((content) => ({ content })) },
      });
      payloads[t.platform] = `thread (${text.items.length} posts)`;
    } else {
      const cap = SINGLE_CAPS[t.slug];
      if (cap !== undefined && overCap(fullText, cap)) {
        return {
          error: `${t.platform} caps posts at ${cap} characters — this thread's full text is ${Array.from(fullText.trim()).length}. Remove ${t.platform} from the slot to post the thread where it fits.`,
        };
      }
      entries.push({ platform: t.slug, accountId: t.accountId });
      payloads[t.platform] = "full text";
    }
  }
  return {
    body: { content: fullText, platforms: entries, publishNow: true },
    payloads,
  };
}

export function parsePublishResponse(json: unknown): {
  postId: string | null;
  receipts: Array<{ platform: string; status: string; postUrl: string | null; error: string | null }>;
} {
  if (typeof json !== "object" || json === null) return { postId: null, receipts: [] };
  const post = (json as Record<string, unknown>)["post"];
  if (typeof post !== "object" || post === null) return { postId: null, receipts: [] };
  const rec = post as Record<string, unknown>;
  const postId = typeof rec["_id"] === "string" ? rec["_id"] : null;
  const list = Array.isArray(rec["platforms"]) ? rec["platforms"] : [];
  const receipts = list
    .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .map((p) => ({
      platform: typeof p["platform"] === "string" ? (p["platform"] as string) : "unknown",
      status: typeof p["status"] === "string" ? (p["status"] as string) : "unknown",
      postUrl: typeof p["platformPostUrl"] === "string" ? (p["platformPostUrl"] as string) : null,
      error: typeof p["errorMessage"] === "string" ? (p["errorMessage"] as string) : null,
    }));
  return { postId, receipts };
}

type SlotRow = {
  id: string;
  status: string;
  content_type: string;
  platforms: string;
  approved_draft_id: string | null;
  approved_option: number | null;
};

type DraftRow = {
  id: string;
  body: string;
  structure: string | null;
  selection: string | null;
};

function loadSlot(slotId: string): SlotRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, status, content_type, platforms, approved_draft_id, approved_option
         FROM queue_slots WHERE id = ?`,
      )
      .get(slotId) as SlotRow | undefined) ?? null
  );
}

function loadDraft(draftId: string): DraftRow | null {
  return (
    (getDb()
      .prepare(`SELECT id, body, structure, selection FROM drafts WHERE id = ?`)
      .get(draftId) as DraftRow | undefined) ?? null
  );
}

// The shippable text: the pinned pick when the slot carries a pin, else the
// latest version's pick. Thread kinds need real hooks-plus-body structure —
// legacy soup can't be split into post items, so those re-draft.
function publishTextFor(slot: SlotRow): PublishText | { error: string } {
  if (!TEXT_KINDS.has(slot.content_type)) {
    return {
      error: `Zernio posting covers text posts and threads in v1 — this is a ${slot.content_type.replace(/_/g, " ")}. Media upload (images, carousels, video) is next; post this one manually for now.`,
    };
  }
  const pin =
    slot.approved_draft_id !== null
      ? { draftId: slot.approved_draft_id, optionIndex: slot.approved_option ?? 0 }
      : resolveApproval(slot.id);
  if (!pin) return { error: "draft this slot before posting" };
  const draft = loadDraft(pin.draftId);
  if (!draft) return { error: "the approved draft is gone — re-approve, then post" };
  const structure = parseStructure(draft.structure);
  if (!THREAD_KINDS.has(slot.content_type)) {
    const count = structure?.options.length ?? splitLegacyOptions(draft.body)?.length ?? 1;
    const idx = clampSelection(String(pin.optionIndex ?? draft.selection ?? 0), count);
    const content = structure
      ? structure.options[idx].body
      : (splitLegacyOptions(draft.body)?.[idx]?.body ?? draft.body);
    return content.trim() ? { mode: "single", content: content.trim() } : { error: "the approved draft is empty" };
  }
  if (!structure || structure.layout !== "hooks-plus-body" || !structure.body) {
    return { error: "this thread predates post items — Draft now to regenerate it, then post" };
  }
  const idx = clampSelection(String(pin.optionIndex ?? draft.selection ?? 0), structure.options.length);
  const items = splitThreadItems(structure.options[idx].body, structure.body);
  if (items.length <= 1) return { mode: "single", content: items[0] ?? "" };
  return { mode: "thread", items };
}

export type PublishDeps = {
  listAccounts: (apiKey: string) => Promise<ZernioAccount[]>;
  createPost: (apiKey: string, body: Record<string, unknown>, key: string) => Promise<unknown>;
};

const DEFAULT_DEPS: PublishDeps = { listAccounts: zernioAccounts, createPost: zernioCreatePost };

function matchTargets(platforms: string[], accounts: ZernioAccount[]): PublishTarget[] | { error: string } {
  if (platforms.length === 0) return { error: "this slot has no platforms — edit it first" };
  const targets: PublishTarget[] = [];
  for (const platform of platforms) {
    const slug = ZERNIO_SLUGS[platform];
    if (!slug) {
      return { error: `${platform} has no connected-account target — post it manually, or drop it from the slot` };
    }
    const matches = accounts.filter((a) => a.platform === slug);
    if (matches.length === 0) {
      return {
        error: `no connected Zernio account for ${platform} — connect it in Zernio, then retry. Nothing was sent.`,
      };
    }
    if (matches.length > 1) {
      return {
        error: `${matches.length} connected ${platform} accounts (${matches.map((m) => `@${m.username}`).join(", ")}) — v1 needs exactly one per platform. Nothing was sent.`,
      };
    }
    targets.push({ platform, slug, accountId: matches[0].id, username: matches[0].username });
  }
  return targets;
}

type AttemptRow = {
  attempt: number;
  idempotency_key: string;
  status: string;
};

// A previous attempt still marked sending/unknown died mid-flight — its key
// must be reused so Zernio dedups instead of double-posting. Otherwise mint
// a fresh attempt number (a failed post object exists under the old key, and
// reusing it would return the failure instead of posting).
function nextAttempt(slotId: string): { attempt: number; key: string } {
  const rows = getDb()
    .prepare(
      `SELECT attempt, idempotency_key, status FROM slot_posts
       WHERE slot_id = ? ORDER BY attempt DESC, rowid DESC`,
    )
    .all(slotId) as AttemptRow[];
  const latest = rows[0];
  if (latest && (latest.status === "sending" || latest.status === "unknown")) {
    return { attempt: latest.attempt, key: latest.idempotency_key };
  }
  const attempt = (latest?.attempt ?? 0) + 1;
  return { attempt, key: `creagent-${slotId}-a${attempt}` };
}

export async function publishSlot(
  slotId: string,
  apiKey: string,
  deps: PublishDeps = DEFAULT_DEPS,
): Promise<PublishResult> {
  const db = getDb();
  const slot = loadSlot(slotId);
  if (!slot) return { ok: false, error: "slot not found" };
  if (slot.status === "gray") return { ok: false, error: "already posted" };
  if (slot.status !== "green") {
    return { ok: false, error: `approve this slot first — only green (ready) slots post, this one is ${slot.status}` };
  }
  const text = publishTextFor(slot);
  if ("error" in text) return { ok: false, error: text.error };
  let accounts: ZernioAccount[];
  try {
    accounts = await deps.listAccounts(apiKey);
  } catch (error) {
    return { ok: false, error: `couldn't list Zernio accounts: ${(error as Error).message}` };
  }
  const allTargets = matchTargets(parseSlotPlatforms(slot.platforms), accounts);
  if ("error" in allTargets) return { ok: false, error: allTargets.error };
  // Retries skip platforms that already published — resending them would
  // just trip Zernio's content dedup (409) instead of finishing the job.
  const done = new Set(
    (
      db
        .prepare(`SELECT DISTINCT platform FROM slot_posts WHERE slot_id = ? AND status = 'published'`)
        .all(slotId) as Array<{ platform: string }>
    ).map((r) => r.platform),
  );
  const carried: PlatformReceipt[] = [];
  if (done.size > 0) {
    const rows = db
      .prepare(
        `SELECT platform, username, payload, status, post_url AS postUrl, error
         FROM slot_posts WHERE slot_id = ? AND status = 'published' ORDER BY attempt DESC`,
      )
      .all(slotId) as Array<{
      platform: string;
      username: string;
      payload: string;
      status: string;
      postUrl: string | null;
      error: string | null;
    }>;
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.platform)) continue;
      seen.add(r.platform);
      carried.push({
        platform: r.platform,
        username: r.username,
        payload: r.payload,
        status: r.status,
        postUrl: r.postUrl,
        error: r.error,
      });
    }
  }
  const targets = allTargets.filter((t) => !done.has(t.platform));
  if (targets.length === 0) {
    db.prepare(`UPDATE queue_slots SET status = 'gray' WHERE id = ?`).run(slotId);
    return { ok: true, postId: null, receipts: carried, slotStatus: "gray" };
  }
  const built = buildPublishBody(text, targets);
  if ("error" in built) return { ok: false, error: built.error };

  const { attempt, key } = nextAttempt(slotId);
  const at = nowIso();
  const payloads = built.payloads;
  // Pre-send rows: a crash between here and the response still leaves the
  // key behind, so the retry reuses it instead of double-posting. A reused
  // attempt rewrites its rows (slot platforms may have changed since).
  db.prepare(`DELETE FROM slot_posts WHERE slot_id = ? AND attempt = ? AND status IN ('sending','unknown')`).run(
    slotId,
    attempt,
  );
  const insert = db.prepare(
    `INSERT INTO slot_posts (id, slot_id, attempt, idempotency_key, platform, account_id, username, payload, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?)`,
  );
  for (const t of targets) {
    insert.run(randomUUID(), slotId, attempt, key, t.platform, t.accountId, t.username, payloads[t.platform] ?? "post", at);
  }
  let json: unknown;
  try {
    json = await deps.createPost(apiKey, built.body, key);
  } catch (error) {
    return {
      ok: false,
      error: `Zernio request failed (${(error as Error).message}) — nothing confirmed. Retry is safe: it reuses the same key.`,
    };
  }
  const parsed = parsePublishResponse(json);
  const bySlug = new Map(parsed.receipts.map((r) => [r.platform, r]));
  const update = db.prepare(
    `UPDATE slot_posts SET zernio_post_id = ?, status = ?, post_url = ?, error = ?
     WHERE slot_id = ? AND attempt = ? AND platform = ?`,
  );
  const receipts: PlatformReceipt[] = targets.map((t) => {
    const r = bySlug.get(t.slug);
    const status = r?.status ?? "unknown";
    update.run(parsed.postId, status, r?.postUrl ?? null, r?.error ?? null, slotId, attempt, t.platform);
    return {
      platform: t.platform,
      username: t.username,
      payload: payloads[t.platform] ?? "post",
      status,
      postUrl: r?.postUrl ?? null,
      error: r?.error ?? (r ? null : "no per-platform result in the Zernio response"),
    };
  });
  const fresh = receipts.filter((r) => r.status === "published");
  const allReceipts = [...carried, ...receipts];
  if (fresh.length === targets.length) {
    db.prepare(`UPDATE queue_slots SET status = 'gray' WHERE id = ?`).run(slotId);
    return { ok: true, postId: parsed.postId, receipts: allReceipts, slotStatus: "gray" };
  }
  const failed = receipts.filter((r) => r.status !== "published");
  const doneCount = carried.length + fresh.length;
  return {
    ok: false,
    postId: parsed.postId,
    receipts: allReceipts,
    error: `posted ${doneCount} of ${allTargets.length} — ${failed.map((f) => `${f.platform}: ${f.error ?? f.status}`).join("; ")}. Fix it and retry; already-posted platforms are skipped.`,
  };
}

export function slotPublishHistory(slotId: string): Array<{
  attempt: number;
  platform: string;
  username: string;
  payload: string;
  status: string;
  postUrl: string | null;
  error: string | null;
  createdAt: string;
}> {
  return (
    getDb()
      .prepare(
        `SELECT attempt, platform, username, payload, status, post_url AS postUrl,
                error, created_at AS createdAt
         FROM slot_posts WHERE slot_id = ? ORDER BY attempt DESC, platform ASC`,
      )
      .all(slotId) as Array<{
      attempt: number;
      platform: string;
      username: string;
      payload: string;
      status: string;
      postUrl: string | null;
      error: string | null;
      createdAt: string;
    }>
  );
}
