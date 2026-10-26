import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROVIDERS = ["meta", "monid", "zernio", "brave"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = {
  meta: "Meta Model API",
  monid: "Monid",
  zernio: "Zernio",
  brave: "Brave Search",
};

const CONFIG_DIR = join(homedir(), ".config", "creagent");
const ENC_PATH = join(CONFIG_DIR, "keys.enc.json");
const KEY_PATH = join(CONFIG_DIR, ".keys.key");

type KeyMap = Record<Provider, string>;

const EMPTY: KeyMap = { meta: "", monid: "", zernio: "", brave: "" };

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadOrCreateKey(): Buffer {
  ensureDir();
  if (existsSync(KEY_PATH)) return readFileSync(KEY_PATH);
  const k = randomBytes(32);
  writeFileSync(KEY_PATH, k, { mode: 0o600 });
  return k;
}

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

export function loadKeys(): KeyMap {
  if (!existsSync(ENC_PATH)) return { ...EMPTY };
  try {
    const raw = JSON.parse(readFileSync(ENC_PATH, "utf8")) as Record<
      string,
      { iv: string; tag: string; data: string } | undefined
    >;
    const key = loadOrCreateKey();
    const out: KeyMap = { ...EMPTY };
    for (const p of PROVIDERS) {
      const entry = raw[p];
      if (!entry) continue;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(entry.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
      out[p] =
        decipher.update(entry.data, "base64", "utf8") + decipher.final("utf8");
    }
    return out;
  } catch {
    return { ...EMPTY };
  }
}

export function saveKey(provider: Provider, value: string): void {
  const keys = loadKeys();
  keys[provider] = value.trim();
  const key = loadOrCreateKey();
  const raw: Record<string, { iv: string; tag: string; data: string }> = {};
  for (const p of PROVIDERS) {
    if (!keys[p]) continue;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data =
      cipher.update(keys[p], "utf8", "base64") + cipher.final("base64");
    raw[p] = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data,
    };
  }
  ensureDir();
  writeFileSync(ENC_PATH, JSON.stringify(raw), { mode: 0o600 });
}

export function maskKey(value: string): string | null {
  if (!value) return null;
  return `\u2022\u2022\u2022\u2022${value.slice(-4)}`;
}

export function configDir(): string {
  return CONFIG_DIR;
}
