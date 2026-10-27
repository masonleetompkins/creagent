"use client";

import { useEffect, useState } from "react";

type ProviderState = {
  id: string;
  label: string;
  set: boolean;
  masked: string | null;
};

type TestState = { kind: "ok" | "err"; text: string } | null;

const ORDER = [
  { id: "meta", label: "Meta Model API" },
  { id: "monid", label: "Monid" },
  { id: "zernio", label: "Zernio" },
  { id: "brave", label: "Brave Search" },
];

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  return data;
}

export default function SettingsForm(): React.ReactNode {
  const [providers, setProviders] = useState<ProviderState[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, TestState>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/keys")
      .then(readJson)
      .then((data) => {
        const list = data.providers as ProviderState[];
        setProviders(
          ORDER.map((o) => {
            const found = list.find((p) => p.id === o.id);
            return {
              id: o.id,
              label: o.label,
              set: found?.set ?? false,
              masked: found?.masked ?? null,
            };
          }),
        );
        setLoaded(true);
      })
      .catch((error: unknown) => {
        setNotes({
          meta: {
            kind: "err",
            text: `Could not load key status: ${(error as Error).message}`,
          },
        });
        setProviders(ORDER.map((o) => ({ ...o, set: false, masked: null })));
        setLoaded(true);
      });
  }, []);

  async function save(id: string): Promise<void> {
    setBusy((b) => ({ ...b, [id]: true }));
    setNotes((n) => ({ ...n, [id]: null }));
    try {
      const data = await readJson(
        await fetch("/api/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: id, key: inputs[id] ?? "" }),
        }),
      );
      setProviders((ps) =>
        ps.map((p) =>
          p.id === id
            ? {
                ...p,
                set: data.set as boolean,
                masked: data.masked as string | null,
              }
            : p,
        ),
      );
      setInputs((s) => ({ ...s, [id]: "" }));
      setNotes((n) => ({
        ...n,
        [id]: {
          kind: "ok",
          text: (data.set as boolean) ? "Saved." : "Cleared.",
        },
      }));
    } catch (error) {
      setNotes((n) => ({
        ...n,
        [id]: { kind: "err", text: (error as Error).message },
      }));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  async function test(id: string): Promise<void> {
    setBusy((b) => ({ ...b, [`${id}:test`]: true }));
    setNotes((n) => ({ ...n, [id]: null }));
    try {
      const data = await readJson(
        await fetch("/api/keys/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: id }),
        }),
      );
      setNotes((n) => ({
        ...n,
        [id]: {
          kind: (data.ok as boolean) ? "ok" : "err",
          text: data.message as string,
        },
      }));
    } catch (error) {
      setNotes((n) => ({
        ...n,
        [id]: { kind: "err", text: (error as Error).message },
      }));
    } finally {
      setBusy((b) => ({ ...b, [`${id}:test`]: false }));
    }
  }

  if (!loaded) return <p className="muted">Loading key status…</p>;

  return (
    <div className="keys-grid">
      {providers.map((p) => (
        <section className="keycard" key={p.id}>
          <h2>
            {p.label}
            <span className={`status ${p.set ? "set" : "unset"}`}>
              {p.set ? `saved ${p.masked ?? ""}` : "not set"}
            </span>
          </h2>
          <div className="row">
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={p.set ? "Enter a new key to replace it" : "Paste key here"}
              value={inputs[p.id] ?? ""}
              onChange={(e) =>
                setInputs((s) => ({ ...s, [p.id]: e.target.value }))
              }
            />
            <button
              className="primary"
              disabled={!!busy[p.id]}
              onClick={() => void save(p.id)}
            >
              {busy[p.id] ? "Saving…" : "Save"}
            </button>
            <button
              disabled={!!busy[`${p.id}:test`] || !p.set}
              onClick={() => void test(p.id)}
            >
              {busy[`${p.id}:test`] ? "Testing…" : "Test"}
            </button>
          </div>
          {notes[p.id] ? (
            <p className={`note ${notes[p.id]?.kind}`}>{notes[p.id]?.text}</p>
          ) : null}
        </section>
      ))}
    </div>
  );
}
