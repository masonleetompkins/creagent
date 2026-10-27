// Vault retrieval over the embedded store: embed the query, brute-force
// cosine against stored float32 BLOBs.
import { getDb } from "./db";
import { blobToVector, cosineSimilarity, embed, vectorToBlob } from "./embeddings";

export type VaultHit = {
  id: string;
  doc_type: string;
  title: string | null;
  body: string;
  score: number;
};

type VaultRow = {
  id: string;
  doc_type: string;
  title: string | null;
  body: string;
  embedding: Uint8Array | null;
};

export async function searchVault(query: string, limit = 5): Promise<VaultHit[]> {
  const rows = getDb()
    .prepare(
      `SELECT id, doc_type, title, body, embedding FROM vault_docs
       WHERE embedding IS NOT NULL`,
    )
    .all() as VaultRow[];
  if (rows.length === 0) return [];
  const q = await embed(query);
  const scored = rows.map((row) => ({
    id: row.id,
    doc_type: row.doc_type,
    title: row.title,
    body: row.body,
    score: row.embedding ? cosineSimilarity(q, blobToVector(row.embedding)) : 0,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit));
}

export async function updateVaultDoc(
  id: string,
  patch: { title?: string | null; body?: string },
): Promise<boolean> {
  const row = getDb().prepare(`SELECT title, body FROM vault_docs WHERE id = ?`).get(id) as
    | { title: string | null; body: string }
    | undefined;
  if (!row) return false;
  const title = patch.title !== undefined ? patch.title : row.title;
  const body = patch.body !== undefined ? patch.body : row.body;
  const vec = await embed(`${title ?? ""}\n${body}`);
  const res = getDb()
    .prepare(`UPDATE vault_docs SET title = ?, body = ?, embedding = ? WHERE id = ?`)
    .run(title, body, vectorToBlob(vec), id);
  return res.changes > 0;
}

export function deleteVaultDoc(id: string): boolean {
  const res = getDb().prepare(`DELETE FROM vault_docs WHERE id = ?`).run(id);
  return res.changes > 0;
}

export function vaultCounts(): Record<string, number> {
  const rows = getDb()
    .prepare(`SELECT doc_type, COUNT(*) AS n FROM vault_docs GROUP BY doc_type`)
    .all() as Array<{ doc_type: string; n: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.doc_type] = row.n;
  return out;
}
