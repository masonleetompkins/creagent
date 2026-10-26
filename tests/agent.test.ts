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
  turns: { content: string | null; toolCalls: { id: string; name: string; args: Record<string, unknown> }[] }[],
) {
  let i = 0;
  return {
    complete: async () => {
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
