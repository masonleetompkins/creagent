import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "creagent-agent-")), "test.sqlite");

before(async () => {
  await import("../scripts/migrate");
});

function scriptedClient(
  turns: {
    content: string | null;
    toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
    usage?: { prompt: number; completion: number };
  }[],
  seen: { role: string; content: string | null }[][] = [],
) {
  let i = 0;
  return {
    complete: async (messages: { role: string; content: string | null }[]) => {
      seen.push(messages);
      const turn = turns[Math.min(i, turns.length - 1)];
      i++;
      return turn;
    },
  };
}

describe("agent loop", () => {
  it("chains tool calls then saves a final message", async () => {
    const { createChat, getMessages, runAgentTurn } = await import("../lib/agent");
    const chatId = createChat("t");
    const result = await runAgentTurn(
      chatId,
      "what is in the brain?",
      scriptedClient([
        { content: null, toolCalls: [{ id: "c1", name: "brain_overview", args: {} }] },
        { content: "Brain is ready.", toolCalls: [] },
      ]),
    );
    assert.equal(result.stopped, "final");
    assert.equal(result.steps, 2);
    const messages = getMessages(chatId);
    assert.deepEqual(
      messages.map((m) => m.role),
      ["user", "tool", "assistant"],
    );
    assert.equal(messages[1].toolName, "brain_overview");
    assert.match(messages[1].content, /"ok":true/);
    assert.equal(messages[2].content, "Brain is ready.");
  });

  it("reports unknown tools and stops at the step cap", async () => {
    const { createChat, getMessages, runAgentTurn } = await import("../lib/agent");
    const chatId = createChat("t");
    const result = await runAgentTurn(
      chatId,
      "go",
      scriptedClient([{ content: null, toolCalls: [{ id: "c1", name: "nope", args: {} }] }]),
      1,
    );
    assert.equal(result.stopped, "max_steps");
    const messages = getMessages(chatId);
    assert.match(messages[messages.length - 1].content, /stopped after 1 tool step/);
  });
});

describe("queue template tools", () => {
  it("adds one slot, fans out everyday, and deletes", async () => {
    const { AGENT_TOOLS } = await import("../lib/agent-tools");
    const { getDb } = await import("../lib/db");
    const run = async (name: string, args: Record<string, unknown>) => {
      const tool = AGENT_TOOLS.find((t) => t.name === name);
      if (!tool) throw new Error(`missing tool ${name}`);
      return tool.run(args);
    };
    const bad = await run("add_template", { time: "9am", content_type: "short_post", platforms: "x", weekday: 1 });
    assert.equal(bad.ok, false);
    const one = await run("add_template", { time: "09:00", content_type: "short_post", platforms: "x,threads", weekday: 1 });
    assert.equal(one.ok, true);
    const daily = await run("add_template", {
      time: "14:00",
      content_type: "thread",
      platforms: "x",
      everyday: true,
    });
    assert.equal(daily.ok, true);
    assert.equal((daily.data as { created: number }).created, 7);
    const again = await run("add_template", {
      time: "14:00",
      content_type: "thread",
      platforms: "x",
      everyday: true,
    });
    assert.equal((again.data as { created: number; skipped: number }).created, 0);
    assert.equal((again.data as { created: number; skipped: number }).skipped, 7);
    const listed = await run("list_templates", {});
    assert.equal((listed.data as unknown[]).length, 8);
    const first = (listed.data as { id: string }[])[0];
    const del = await run("delete_template", { id: first.id });
    assert.equal(del.ok, true);
    const db = getDb();
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM queue_templates`).get() as { n: number }).n;
    assert.equal(n, 7);
    const pillars = await run("list_pillars", {});
    assert.equal(pillars.ok, true);
  });
});

describe("agent tool guards", () => {
  it("refuses Posted status and off-domain audio", async () => {
    const { AGENT_TOOLS } = await import("../lib/agent-tools");
    const db = await import("../lib/db");
    const conn = db.getDb();
    conn.prepare(
      `INSERT INTO queue_slots (id, scheduled_at, content_type, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("00000000-0000-4000-8000-000000000000", db.nowIso(), "short_post", "red", db.nowIso());
    const setStatus = AGENT_TOOLS.find((t) => t.name === "set_slot_status");
    assert.ok(setStatus);
    const gray = await setStatus.run({ slotId: "00000000-0000-4000-8000-000000000000", status: "gray" });
    assert.equal(gray.ok, false);
    assert.match(gray.error ?? "", /only the user marks Posted/);
    const green = await setStatus.run({ slotId: "00000000-0000-4000-8000-000000000000", status: "green" });
    assert.equal(green.ok, true);
    const fetch = AGENT_TOOLS.find((t) => t.name === "audio_fetch");
    assert.ok(fetch);
    const bad = await fetch.run({ kind: "sfx", title: "x", url: "https://evil.example/x.mp3" });
    assert.equal(bad.ok, false);
  });

  it("edits clips and drafts through tools", async () => {
    const { AGENT_TOOLS } = await import("../lib/agent-tools");
    const video = await import("../lib/video");
    const db = await import("../lib/db");
    const conn = db.getDb();
    const projectId = `p-${Date.now()}`;
    conn.prepare(
      `INSERT INTO video_projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(projectId, "t", db.nowIso(), db.nowIso());
    const track = video.addTrack(projectId, "video", "V1");
    const addClip = AGENT_TOOLS.find((t) => t.name === "add_clip");
    assert.ok(addClip);
    const added = await addClip.run({ trackId: track.id, durationMs: 2000 });
    assert.equal(added.ok, true);
    const clipId = (added.data as { id: string }).id;
    const editClip = AGENT_TOOLS.find((t) => t.name === "edit_clip");
    assert.ok(editClip);
    const trimmed = await editClip.run({ clipId, durationMs: 1500 });
    assert.equal(trimmed.ok, true);
    assert.equal(video.getClip(clipId)?.duration_ms, 1500);
    const bad = await editClip.run({ clipId: "not-a-uuid", durationMs: 5 });
    assert.equal(bad.ok, false);
  });
});

describe("agent usage and compaction", () => {
  it("accumulates reported usage into cost and context", async () => {
    const { createChat, listChats, runAgentTurn } = await import("../lib/agent");
    const chatId = createChat("usage");
    await runAgentTurn(
      chatId,
      "hi",
      scriptedClient([
        {
          content: "done",
          toolCalls: [],
          usage: { prompt: 1000, completion: 50 },
        },
      ]),
    );
    const row = listChats().find((c) => c.id === chatId);
    assert.ok(row);
    assert.equal(row.prompt_tokens, 1000);
    assert.equal(row.completion_tokens, 50);
    assert.equal(row.last_context_tokens, 1000);
    assert.ok(row.cost_usd > 0);
    assert.ok(row.ctx_pct > 0 && row.ctx_pct < 100);
  });

  it("compacts long history into an anchor and drops it from context", async () => {
    const { compactChat, createChat, getMessages, runAgentTurn, saveMessage } =
      await import("../lib/agent");
    const chatId = createChat("compact");
    const filler = "lorem ipsum dolor sit amet ".repeat(40);
    for (let i = 0; i < 5; i++) {
      saveMessage(chatId, { role: i % 2 === 0 ? "user" : "assistant", content: `${filler} #${i}` });
    }
    const tiny = createChat("tiny");
    saveMessage(tiny, { role: "user", content: "hi" });
    const skipped = await compactChat(
      tiny,
      scriptedClient([{ content: "unused", toolCalls: [] }]),
    );
    assert.equal(skipped.compacted, false);
    const result = await compactChat(
      chatId,
      scriptedClient([{ content: "SUMMARY OF WORK", toolCalls: [] }]),
    );
    assert.equal(result.compacted, true);
    const messages = getMessages(chatId);
    assert.equal(messages.filter((m) => m.compacted).length, 5);
    const anchor = messages.find((m) => !m.compacted);
    assert.ok(anchor);
    assert.match(anchor.content, /SUMMARY OF WORK/);
    const seen: { role: string; content: string | null }[][] = [];
    await runAgentTurn(chatId, "continue", scriptedClient([{ content: "ok", toolCalls: [] }], seen));
    const joined = seen[0].map((m) => m.content ?? "").join("\n");
    assert.match(joined, /SUMMARY OF WORK/);
    assert.doesNotMatch(joined, /lorem ipsum/);
  });
});
