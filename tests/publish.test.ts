import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-publish-")), "test.sqlite");

before(async () => {
  await import("../scripts/migrate");
});

describe("splitThreadItems", () => {
  it("leads with the hook, then blank-line-separated posts", async () => {
    const { splitThreadItems } = await import("../lib/publish");
    assert.deepEqual(splitThreadItems("Hook here", "1/ First.\n\n2/ Second.\n\n\n3/ Third."), [
      "Hook here",
      "1/ First.",
      "2/ Second.",
      "3/ Third.",
    ]);
  });
});

describe("buildPublishBody", () => {
  it("builds a publishNow single with slug entries", async () => {
    const { buildPublishBody } = await import("../lib/publish");
    const out = buildPublishBody(
      { mode: "single", content: "hello" },
      [
        { platform: "x", slug: "twitter", accountId: "a1", username: "me" },
        { platform: "threads", slug: "threads", accountId: "a2", username: "me" },
      ],
    );
    assert.ok(!("error" in out));
    assert.deepEqual(out.body, {
      content: "hello",
      platforms: [
        { platform: "twitter", accountId: "a1" },
        { platform: "threads", accountId: "a2" },
      ],
      publishNow: true,
    });
    assert.deepEqual(out.payloads, { x: "post", threads: "post" });
  });

  it("rejects over-cap singles before sending", async () => {
    const { buildPublishBody } = await import("../lib/publish");
    const out = buildPublishBody(
      { mode: "single", content: "x".repeat(281) },
      [{ platform: "x", slug: "twitter", accountId: "a1", username: "me" }],
    );
    assert.ok("error" in out);
    assert.match(out.error, /280 characters/);
  });

  it("threads to thread platforms, full text elsewhere", async () => {
    const { buildPublishBody } = await import("../lib/publish");
    const out = buildPublishBody(
      { mode: "thread", items: ["Hook", "1/ Body", "2/ End"] },
      [
        { platform: "x", slug: "twitter", accountId: "a1", username: "me" },
        { platform: "linkedin", slug: "linkedin", accountId: "a3", username: "me" },
      ],
    );
    assert.ok(!("error" in out));
    const platforms = out.body["platforms"] as Array<Record<string, unknown>>;
    assert.equal(platforms.length, 2);
    assert.deepEqual(
      (platforms[0]["platformSpecificData"] as { threadItems: Array<{ content: string }> })
        .threadItems,
      [{ content: "Hook" }, { content: "1/ Body" }, { content: "2/ End" }],
    );
    assert.ok(!("platformSpecificData" in platforms[1]));
    assert.equal(out.body["content"], "Hook\n\n1/ Body\n\n2/ End");
    assert.deepEqual(out.payloads, { x: "thread (3 posts)", linkedin: "full text" });
  });

  it("rejects over-long thread items and over-long cross-posts", async () => {
    const { buildPublishBody } = await import("../lib/publish");
    const badItem = buildPublishBody(
      { mode: "thread", items: ["Hook", "x".repeat(281)] },
      [{ platform: "x", slug: "twitter", accountId: "a1", username: "me" }],
    );
    assert.ok("error" in badItem);
    assert.match(badItem.error, /post 2 is over/);
    const badCross = buildPublishBody(
      { mode: "thread", items: ["Hook", "y".repeat(3001)] },
      [{ platform: "linkedin", slug: "linkedin", accountId: "a3", username: "me" }],
    );
    assert.ok("error" in badCross);
    assert.match(badCross.error, /3000/);
  });
});

describe("parsePublishResponse", () => {
  it("reads post id and per-platform results", async () => {
    const { parsePublishResponse } = await import("../lib/publish");
    const out = parsePublishResponse({
      post: {
        _id: "zp1",
        status: "partial",
        platforms: [
          { platform: "twitter", status: "published", platformPostUrl: "https://x.com/u/1" },
          { platform: "threads", status: "failed", errorMessage: "Param text too long" },
        ],
      },
    });
    assert.equal(out.postId, "zp1");
    assert.equal(out.receipts.length, 2);
    assert.equal(out.receipts[0].postUrl, "https://x.com/u/1");
    assert.equal(out.receipts[1].error, "Param text too long");
  });

  it("tolerates malformed responses", async () => {
    const { parsePublishResponse } = await import("../lib/publish");
    assert.deepEqual(parsePublishResponse(null), { postId: null, receipts: [] });
    assert.deepEqual(parsePublishResponse({}), { postId: null, receipts: [] });
    assert.deepEqual(parsePublishResponse({ post: { _id: "z" } }), {
      postId: "z",
      receipts: [],
    });
  });
});

describe("publishSlot", () => {
  async function seed(opts: {
    status: string;
    contentType: string;
    platforms: string[];
    approvedOption?: number;
    draft?: { structure: unknown; selection?: string; body?: string };
  }): Promise<string> {
    const { getDb, nowIso } = await import("../lib/db");
    const db = getDb();
    const slotId = randomUUID();
    const at = nowIso();
    db.prepare(
      `INSERT INTO queue_slots (id, scheduled_at, content_type, platforms, status, brief, created_at)
       VALUES (?, ?, ?, ?, ?, '{}', ?)`,
    ).run(slotId, at, opts.contentType, JSON.stringify(opts.platforms), opts.status, at);
    if (opts.draft) {
      const draftId = randomUUID();
      db.prepare(
        `INSERT INTO drafts (id, slot_id, kind, body, status, created_at, structure, selection)
         VALUES (?, ?, ?, 'draft body', 'draft', ?, ?, ?)`,
      ).run(
        draftId,
        slotId,
        opts.contentType,
        at,
        opts.draft.structure ? JSON.stringify(opts.draft.structure) : null,
        opts.draft.selection ?? null,
      );
      db.prepare(`UPDATE queue_slots SET approved_draft_id = ?, approved_option = ? WHERE id = ?`).run(
        draftId,
        opts.approvedOption ?? 0,
        slotId,
      );
    }
    return slotId;
  }

  function deps(impl: {
    accounts?: Array<{ id: string; platform: string; username: string }>;
    onPost?: (body: Record<string, unknown>, key: string) => unknown;
  }) {
    const sent: Array<{ body: Record<string, unknown>; key: string }> = [];
    return {
      sent,
      accounts: impl.accounts ?? [{ id: "a1", platform: "twitter", username: "me" }],
      createPost: async (_apiKey: string, body: Record<string, unknown>, key: string) => {
        sent.push({ body, key });
        return impl.onPost?.(body, key) ?? { post: { _id: "zp", platforms: [] } };
      },
    };
  }

  it("only posts green slots", async () => {
    const { publishSlot } = await import("../lib/publish");
    for (const status of ["red", "orange", "gray"]) {
      const slotId = await seed({ status, contentType: "short_post", platforms: ["x"] });
      const d = deps({});
      const res = await publishSlot(slotId, "k", {
        listAccounts: async () => d.accounts,
        createPost: d.createPost,
      });
      assert.equal(res.ok, false);
      assert.equal(d.sent.length, 0);
    }
  });

  it("refuses media kinds and account mismatches without sending", async () => {
    const { publishSlot } = await import("../lib/publish");
    const run = async (slotId: string, accounts: Array<{ id: string; platform: string; username: string }>) => {
      const d = deps({ accounts });
      const res = await publishSlot(slotId, "k", {
        listAccounts: async () => d.accounts,
        createPost: d.createPost,
      });
      assert.equal(res.ok, false);
      assert.equal(d.sent.length, 0);
      return res.ok === false ? res.error : "";
    };
    const video = await seed({
      status: "green",
      contentType: "video_yap",
      platforms: ["tiktok"],
      draft: { structure: null },
    });
    assert.match(await run(video, [{ id: "t1", platform: "tiktok", username: "me" }]), /text posts and threads/);
    const missing = await seed({
      status: "green",
      contentType: "short_post",
      platforms: ["x"],
      draft: { structure: { layout: "prose", options: [{ label: "D", body: "hi" }] } },
    });
    assert.match(await run(missing, []), /no connected Zernio account/);
    const ambiguous = await seed({
      status: "green",
      contentType: "short_post",
      platforms: ["x"],
      draft: { structure: { layout: "prose", options: [{ label: "D", body: "hi" }] } },
    });
    assert.match(
      await run(ambiguous, [
        { id: "a1", platform: "twitter", username: "one" },
        { id: "a2", platform: "twitter", username: "two" },
      ]),
      /exactly one per platform/,
    );
  });

  it("publishes, records receipts, and flips gray", async () => {
    const { publishSlot, slotPublishHistory } = await import("../lib/publish");
    const { getDb } = await import("../lib/db");
    const slotId = await seed({
      status: "green",
      contentType: "short_post",
      platforms: ["x"],
      draft: { structure: { layout: "prose", options: [{ label: "D", body: "hello world" }] } },
    });
    const d = deps({
      onPost: () => ({
        post: {
          _id: "zp1",
          platforms: [{ platform: "twitter", status: "published", platformPostUrl: "https://x.com/me/1" }],
        },
      }),
    });
    const res = await publishSlot(slotId, "k", {
      listAccounts: async () => d.accounts,
      createPost: d.createPost,
    });
    assert.equal(res.ok, true);
    assert.equal(d.sent.length, 1);
    assert.equal((d.sent[0].body["content"] as string), "hello world");
    assert.match(d.sent[0].key, new RegExp(`^creagent-${slotId}-a1$`));
    const status = (getDb().prepare(`SELECT status FROM queue_slots WHERE id = ?`).get(slotId) as { status: string }).status;
    assert.equal(status, "gray");
    const history = slotPublishHistory(slotId);
    assert.equal(history.length, 1);
    assert.equal(history[0].status, "published");
    assert.equal(history[0].postUrl, "https://x.com/me/1");
  });

  it("stays green on partial failure; retry skips what published", async () => {
    const { publishSlot } = await import("../lib/publish");
    const { getDb } = await import("../lib/db");
    const slotId = await seed({
      status: "green",
      contentType: "short_post",
      platforms: ["x", "threads"],
      draft: { structure: { layout: "prose", options: [{ label: "D", body: "hello" }] } },
    });
    const accounts = [
      { id: "a1", platform: "twitter", username: "me" },
      { id: "a2", platform: "threads", username: "me" },
    ];
    let calls = 0;
    const d = deps({
      accounts,
      onPost: () => {
        calls += 1;
        return calls === 1
          ? {
              post: {
                _id: "zp1",
                platforms: [
                  { platform: "twitter", status: "published", platformPostUrl: "https://x.com/me/1" },
                  { platform: "threads", status: "failed", errorMessage: "boom" },
                ],
              },
            }
          : {
              post: {
                _id: "zp2",
                platforms: [{ platform: "threads", status: "published", platformPostUrl: "https://threads.net/t/1" }],
              },
            };
      },
    });
    const run = () =>
      publishSlot(slotId, "k", { listAccounts: async () => d.accounts, createPost: d.createPost });
    const first = await run();
    assert.equal(first.ok, false);
    if (first.ok) throw new Error("unreachable");
    assert.equal(first.receipts?.length, 2);
    const mid = (getDb().prepare(`SELECT status FROM queue_slots WHERE id = ?`).get(slotId) as { status: string }).status;
    assert.equal(mid, "green");
    const second = await run();
    assert.equal(second.ok, true);
    // Retry sent threads only, under a fresh attempt key.
    assert.equal(d.sent.length, 2);
    assert.deepEqual(
      (d.sent[1].body["platforms"] as Array<Record<string, string>>).map((p) => p["platform"]),
      ["threads"],
    );
    assert.notEqual(d.sent[1].key, d.sent[0].key);
  });

  it("reuses the key when the previous attempt died mid-flight", async () => {
    const { publishSlot } = await import("../lib/publish");
    const slotId = await seed({
      status: "green",
      contentType: "short_post",
      platforms: ["x"],
      draft: { structure: { layout: "prose", options: [{ label: "D", body: "hi" }] } },
    });
    let calls = 0;
    const d = deps({
      onPost: () => {
        calls += 1;
        if (calls === 1) throw new Error("socket hangup");
        return { post: { _id: "zp9", platforms: [{ platform: "twitter", status: "published" }] } };
      },
    });
    const run = () =>
      publishSlot(slotId, "k", { listAccounts: async () => d.accounts, createPost: d.createPost });
    const first = await run();
    assert.equal(first.ok, false);
    const second = await run();
    assert.equal(second.ok, true);
    assert.equal(d.sent[0].key, d.sent[1].key);
  });

  it("sends thread items for thread drafts", async () => {
    const { publishSlot } = await import("../lib/publish");
    const slotId = await seed({
      status: "green",
      contentType: "thread",
      platforms: ["x"],
      approvedOption: 1,
      draft: {
        selection: "1",
        structure: {
          layout: "hooks-plus-body",
          options: [
            { label: "H1", body: "hook one" },
            { label: "H2", body: "hook two" },
          ],
          body: "1/ First.\n\n2/ Second.",
        },
      },
    });
    const d = deps({
      onPost: () => ({ post: { _id: "zpt", platforms: [{ platform: "twitter", status: "published" }] } }),
    });
    const res = await publishSlot(slotId, "k", {
      listAccounts: async () => d.accounts,
      createPost: d.createPost,
    });
    assert.equal(res.ok, true);
    const entry = (d.sent[0].body["platforms"] as Array<Record<string, unknown>>)[0];
    assert.deepEqual(
      (entry["platformSpecificData"] as { threadItems: Array<{ content: string }> }).threadItems,
      [{ content: "hook two" }, { content: "1/ First." }, { content: "2/ Second." }],
    );
  });
});
