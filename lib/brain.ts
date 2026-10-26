// Brain reads: voice profile, vault browser, posting strategy, playbook.
// Nothing here writes; analysis owns the data.
import { CONTENT_TYPES, PLAYBOOK } from "./content";
import { getDb } from "./db";
import { vaultCounts } from "./vault";

export type VaultDoc = {
  id: string;
  doc_type: string;
  title: string | null;
  body: string;
  created_at: string;
};

export function getVoice(): VaultDoc | null {
  const row = getDb()
    .prepare(
      `SELECT id, doc_type, title, body, created_at FROM vault_docs
       WHERE doc_type = 'voice' ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as VaultDoc | undefined;
  return row ?? null;
}

const VAULT_TYPES = ["qa", "principle", "quote", "pillar", "metric", "voice"] as const;

export function listVault(type?: string, limit = 50): VaultDoc[] {
  const db = getDb();
  const capped = Math.min(200, Math.max(1, limit));
  if (type && (VAULT_TYPES as readonly string[]).includes(type)) {
    return db
      .prepare(
        `SELECT id, doc_type, title, body, created_at FROM vault_docs
         WHERE doc_type = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(type, capped) as VaultDoc[];
  }
  return db
    .prepare(
      `SELECT id, doc_type, title, body, created_at FROM vault_docs
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(capped) as VaultDoc[];
}

export type StrategyTemplate = {
  weekday: number;
  time: string;
  pillar_name: string | null;
  content_type: string;
  platforms: string;
};

export function getStrategy(): StrategyTemplate[] {
  return getDb()
    .prepare(
      `SELECT t.weekday, t.time, p.name AS pillar_name, t.content_type, t.platforms
       FROM queue_templates t LEFT JOIN pillars p ON p.id = t.pillar_id
       ORDER BY t.weekday ASC, t.time ASC`,
    )
    .all() as StrategyTemplate[];
}

export function getPlaybook(): { type: string; label: string; hint: string; guide: string }[] {
  return Object.entries(CONTENT_TYPES).map(([type, info]) => ({
    type,
    label: info.label,
    hint: info.hint,
    guide: PLAYBOOK[type] ?? "",
  }));
}

export function brainOverview(): {
  voice: VaultDoc | null;
  counts: Record<string, number>;
  strategy: StrategyTemplate[];
  playbook: { type: string; label: string; hint: string; guide: string }[];
} {
  return { voice: getVoice(), counts: vaultCounts(), strategy: getStrategy(), playbook: getPlaybook() };
}
