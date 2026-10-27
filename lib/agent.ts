// Chat agent: persisted conversations + a tool-calling loop over AGENT_TOOLS.
// Runs inside the worker (agent_turn job). The chat client is injectable so
// tests drive the loop without touching the Meta API.
import { randomUUID } from "node:crypto";
import { getDb, nowIso, withTransaction } from "./db";
import { loadKeys } from "./keys";
import { META_CONTEXT_TOKENS, getMetaClient, metaTextModel, textCostUsd } from "./meta";
import { AGENT_TOOLS } from "./agent-tools";

export const AGENT_SYSTEM = `You are Creagent, the creator's ghostwriter and editor, working inside their local content app.
Rules you must follow:
- Queue slots are red (needs work), orange (needs user review), green (ready). Only the USER marks Posted; never claim something is posted.
- Image generation spends credits: only create approval-gated gen requests (carousel_plan_images), never generate directly. There is no direct image tool; that is intentional.
- Transcription, keying, export, ingest, analysis, and drafting run as background jobs: call the tool once, report the jobId, and stop. Do not poll; the user follows up.
- Match the creator's voice using vault_search before writing anything user-facing.
- Prefer small reversible edits; say what you changed and what to review.
- Keep replies short. Name IDs you acted on.`;

export type AgentMsg = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string | null;
};

export function createChat(title = "New chat"): string {
  const id = randomUUID();
  getDb()
    .prepare(`INSERT INTO agent_chats (id, title, created_at) VALUES (?, ?, ?)`)
    .run(id, title.slice(0, 120), nowIso());
  return id;
}

export type ChatRow = {
  id: string;
  title: string;
  created_at: string;
  position: number;
  prompt_tokens: number;
  completion_tokens: number;
  last_context_tokens: number;
  cost_usd: number;
  ctx_pct: number;
};

export function listChats(): ChatRow[] {
  const model = metaTextModel();
  const rows = getDb()
    .prepare(
      `SELECT id, title, created_at, position, prompt_tokens, completion_tokens, last_context_tokens
       FROM agent_chats ORDER BY position ASC, created_at DESC LIMIT 100`,
    )
    .all() as Omit<ChatRow, "cost_usd" | "ctx_pct">[];
  return rows.map((r) => ({
    ...r,
    cost_usd: textCostUsd(model, r.prompt_tokens, r.completion_tokens),
    ctx_pct: Math.round((r.last_context_tokens / META_CONTEXT_TOKENS) * 1000) / 10,
  }));
}

function chatExists(id: string): boolean {
  const row = getDb().prepare(`SELECT id FROM agent_chats WHERE id = ?`).get(id);
  return row != null;
}

export function renameChat(id: string, title: string): void {
  const t = title.trim().slice(0, 120);
  if (!t) throw new Error("Title can't be empty.");
  const info = getDb().prepare(`UPDATE agent_chats SET title = ? WHERE id = ?`).run(t, id);
  if (Number(info.changes) === 0) throw new Error("Chat not found.");
}

export function deleteChat(id: string): void {
  const info = getDb().prepare(`DELETE FROM agent_chats WHERE id = ?`).run(id);
  if (Number(info.changes) === 0) throw new Error("Chat not found.");
}

export function reorderChats(orderedIds: string[]): void {
  const upd = getDb().prepare(`UPDATE agent_chats SET position = ? WHERE id = ?`);
  withTransaction(() => {
    orderedIds.forEach((id, i) => upd.run(i, id));
  });
}

export type StoredMsg = AgentMsg & { id: string; created_at: string; compacted: number };

export function getMessages(chatId: string): StoredMsg[] {
  return getDb()
    .prepare(
      `SELECT id, role, content, tool_name AS toolName, compacted, created_at FROM agent_messages
       WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 500`,
    )
    .all(chatId) as StoredMsg[];
}

export function saveMessage(chatId: string, msg: AgentMsg): string {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO agent_messages (id, chat_id, role, content, tool_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, chatId, msg.role, msg.content, msg.toolName ?? null, nowIso());
  return id;
}

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
};

export type Usage = { prompt: number; completion: number };

export type ChatClient = {
  complete: (messages: ChatMessage[]) => Promise<{
    content: string | null;
    toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
    usage?: Usage;
  }>;
};

// Fallback when the API reports no usage: ~4 chars per token.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function requestSize(messages: Array<{ role: string; content: string | null }>): number {
  return estimateTokens(messages.map((m) => `${m.role}:${m.content ?? ""}`).join("\n"));
}

export function metaChatClient(): ChatClient {
  const keys = loadKeys();
  if (!keys.meta) throw new Error("Meta API key is not set (add it in Settings)");
  const client = getMetaClient(keys.meta);
  return {
    complete: async (messages: ChatMessage[]) => {
      const res = await client.chat.completions.create({
        model: metaTextModel(),
        max_tokens: 4000,
        messages: messages as never,
        tools: AGENT_TOOLS.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })) as never,
        tool_choice: "auto",
      });
      const msg = res.choices[0]?.message as unknown as {
        content?: string | null;
        tool_calls?: { id: string; function?: { name?: string; arguments?: string } }[];
      };
      const toolCalls = (msg?.tool_calls ?? []).map((c) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.function?.arguments ?? "{}") as Record<string, unknown>;
        } catch {
          /* model sent bad JSON; handler validation reports it */
        }
        return { id: c.id, name: c.function?.name ?? "", args };
      });
      const content = msg?.content ?? null;
      const reported = (res as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } })
        .usage;
      const prompt =
        typeof reported?.prompt_tokens === "number" ? reported.prompt_tokens : requestSize(messages);
      const completion =
        typeof reported?.completion_tokens === "number"
          ? reported.completion_tokens
          : estimateTokens(`${content ?? ""}\n${JSON.stringify(toolCalls)}`);
      return { content, toolCalls, usage: { prompt, completion } };
    },
  };
}

function toolJson(result: unknown): string {
  return JSON.stringify(result).slice(0, 12000);
}

export function recordUsage(chatId: string, prompt: number, completion: number): void {
  getDb()
    .prepare(
      `UPDATE agent_chats
       SET prompt_tokens = prompt_tokens + ?,
           completion_tokens = completion_tokens + ?,
           last_context_tokens = MAX(last_context_tokens, ?)
       WHERE id = ?`,
    )
    .run(prompt, completion, prompt, chatId);
}

// Summarize history into one anchor message; old turns stay visible but
// leave the model context. Returns false when there is nothing worth it.
export async function compactChat(
  chatId: string,
  client: ChatClient = metaChatClient(),
): Promise<{ compacted: boolean; before: number; after: number }> {
  const open = getMessages(chatId).filter((m) => !m.compacted);
  const before = open.reduce((n, m) => n + m.content.length, 0);
  if (open.length < 4 || before < 4000) return { compacted: false, before, after: before };
  const { content } = await client.complete([
    {
      role: "system",
      content:
        "Summarize this creator-agent conversation for continuity: decisions made, work completed with IDs, and open threads. Under 1500 characters, no preamble.",
    },
    {
      role: "user",
      content: open
        .filter((m) => m.role !== "tool")
        .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
        .join("\n\n")
        .slice(0, 60000),
    },
  ]);
  const summary = (content ?? "").trim().slice(0, 2000) || "(empty summary)";
  recordUsage(chatId, requestSize(open), estimateTokens(summary));
  withTransaction(() => {
    getDb().prepare(`UPDATE agent_messages SET compacted = 1 WHERE chat_id = ?`).run(chatId);
    saveMessage(chatId, { role: "assistant", content: `📌 Context compacted:\n${summary}` });
  });
  return { compacted: true, before, after: summary.length };
}

// Run one user turn: loop model <-> tools until a final message or the cap.
export async function runAgentTurn(
  chatId: string,
  userText: string,
  client: ChatClient = metaChatClient(),
  maxSteps = 12,
): Promise<{ steps: number; stopped: string }> {
  if (chatExists(chatId)) {
    const row = getDb().prepare(`SELECT title FROM agent_chats WHERE id = ?`).get(chatId) as
      | { title: string }
      | undefined;
    if (row?.title === "New chat") {
      const auto = userText.trim().replace(/\s+/g, " ").slice(0, 48);
      if (auto) getDb().prepare(`UPDATE agent_chats SET title = ? WHERE id = ?`).run(auto, chatId);
    }
  }
  saveMessage(chatId, { role: "user", content: userText });
  const history = getMessages(chatId).filter((m) => m.role !== "tool" && !m.compacted);
  const messages: ChatMessage[] = [
    { role: "system", content: AGENT_SYSTEM },
    ...history.map((m): ChatMessage => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
  ];
  // Tool results are only meaningful inside this turn's model context, not
  // across turns; keep history to user/assistant turns.
  let steps = 0;
  for (;;) {
    steps++;
    const { content, toolCalls, usage } = await client.complete(messages);
    recordUsage(
      chatId,
      usage?.prompt ?? requestSize(messages),
      usage?.completion ?? estimateTokens(`${content ?? ""}\n${JSON.stringify(toolCalls)}`),
    );
    if (toolCalls.length === 0) {
      saveMessage(chatId, { role: "assistant", content: content ?? "" });
      return { steps, stopped: "final" };
    }
    if (steps >= maxSteps) {
      saveMessage(chatId, {
        role: "assistant",
        content: `${content ?? ""}\n\n(stopped after ${maxSteps} tool steps; ask me to continue.)`.trim(),
      });
      return { steps, stopped: "max_steps" };
    }
    messages.push({
      role: "assistant",
      content,
      tool_calls: toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    });
    for (const call of toolCalls) {
      const tool = AGENT_TOOLS.find((t) => t.name === call.name);
      const result = tool
        ? await tool.run(call.args)
        : { ok: false, error: `unknown tool: ${call.name}` };
      saveMessage(chatId, {
        role: "tool",
        content: toolJson(result),
        toolName: call.name,
      });
      messages.push({
        role: "tool",
        content: toolJson(result),
        tool_call_id: call.id,
        name: call.name,
      });
    }
  }
}
