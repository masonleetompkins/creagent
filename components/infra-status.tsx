"use client";

import { useEffect, useState } from "react";

type Check = { ok: boolean; error?: string };
type Health = {
  db: Check;
  queue: Check;
  keys: { meta: boolean; monid: boolean; zernio: boolean; brave: boolean };
};

function Line({ label, check }: { label: string; check: Check }): React.ReactNode {
  return (
    <p className={`note ${check.ok ? "ok" : "err"}`}>
      {label}: {check.ok ? "up" : `down — ${check.error ?? "unknown error"}`}
    </p>
  );
}

export default function InfraStatus(): React.ReactNode {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json() as Promise<Health>)
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  if (!health) return <p className="muted">Checking system status…</p>;

  const saved = Object.entries(health.keys)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(", ");

  return (
    <section className="keycard">
      <Line label="Database (embedded SQLite)" check={health.db} />
      <Line label="Job queue (embedded)" check={health.queue} />
      <p className="note">
        Keys saved: {saved || "none yet — see Settings"}.
      </p>
    </section>
  );
}
