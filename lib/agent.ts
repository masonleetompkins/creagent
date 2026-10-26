// Chat agent: persisted conversations + a tool-calling loop over AGENT_TOOLS.
// Runs inside the worker (agent_turn job). The chat client is injectable so
// tests drive the loop without touching the Meta API.
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";
import { loadKeys } from "./keys";
import { getMetaClient, metaTextModel } from "./meta";
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

export function listChats(): { id: string; title: string; created_at: string }[] {
  return getDb()
    .prepare(`SELECT id, title, created_at FROM agent_chats ORDER BY created_at DESC LIMIT 50`)
    .all() as { id: string; title: string; created_at: string }[];
}

export function getMessages(chatId: string): (AgentMsg & { id: string; created_at: string })[] {
  return getDb()
    .prepare(
      `SELECT id, role, content, tool_name AS toolName, created_at FROM agent_messages
       WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 500`,
    )
    .all(chatId) as (AgentMsg & { id: string; created_at: string })[];
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

export type ChatClient = {
  complete: (messages: ChatMessage[]) => Promise<{
    content: string | null;
    toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  }>;
};

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
      return { content: msg?.content ?? null, toolCalls };
    },
  };
}

function toolJson(result: unknown): string {
  return JSON.stringify(result).slice(0, 12000);
}

// Run one user turn: loop model <-> tools until a final message or the cap.
export async function runAgentTurn(
  chatId: string,
  userText: string,
  client: ChatClient = metaChatClient(),
  maxSteps = 12,
): Promise<{ steps: number; stopped: string }> {
  saveMessage(chatId, { role: "user", content: userText });
  const history = getMessages(chatId).filter((m) => m.role !== "tool");
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
    const { content, toolCalls } = await client.complete(messages);
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
