// Local embeddings for the vault (Meta has no embeddings endpoint).
// Worker-side only: downloads the ~23MB MiniLM model on first use.
// Output is 384-dim to match vault_docs.embedding vector(384).
import { homedir } from "node:os";
import { join } from "node:path";
import { env, pipeline } from "@xenova/transformers";

env.cacheDir = join(homedir(), ".config", "creagent", "models");
env.allowLocalModels = false;

type Extractor = (
  text: string,
  opts: { pooling: string; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>;

let pipePromise: Promise<Extractor> | null = null;

function getPipe(): Promise<Extractor> {
  if (!pipePromise) {
    pipePromise = pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
    ) as unknown as Promise<Extractor>;
  }
  return pipePromise;
}

export async function embed(text: string): Promise<number[]> {
  const pipe = await getPipe();
  const out = await pipe(text.slice(0, 1500), {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(out.data);
}

export async function embedMany(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}

// SQLite storage: float32 BLOB. Brute-force cosine in JS is plenty fast at
// vault scale (hundreds of docs), so no native vector extension is needed.
export function vectorToBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

export function blobToVector(blob: Uint8Array): number[] {
  const view = new Float32Array(
    blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength),
  );
  return Array.from(view);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
