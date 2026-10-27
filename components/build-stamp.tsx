"use client";

import { useEffect, useState } from "react";

export default function BuildStamp({ pageBuild }: { pageBuild: string }): React.ReactNode {
  const short = pageBuild === "dev" ? "dev" : pageBuild.slice(0, 8);
  const [serverBuild, setServerBuild] = useState<string | null>(null);
  const [diskBuild, setDiskBuild] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/health", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { buildId?: string; diskBuildId?: string } | null) => {
        if (!alive) return;
        if (d?.buildId) setServerBuild(d.buildId);
        if (d?.diskBuildId) setDiskBuild(d.diskBuildId);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const real = (b: string | null): boolean => b !== null && b !== "dev" && pageBuild !== "dev";
  const newOnDisk = real(diskBuild) && diskBuild !== pageBuild;
  const tabStale = !newOnDisk && real(serverBuild) && serverBuild !== pageBuild;
  const stale = newOnDisk || tabStale;
  const label = newOnDisk
    ? `build ${short} · new build on disk — relaunch Creagent`
    : tabStale
      ? `build ${short} · tab is stale — press ⇧⌘R`
      : `build ${short}`;
  return (
    <span className={`build-stamp${stale ? " stale" : ""}`} title={label}>
      <span className="dot" aria-hidden="true" />
      {label}
    </span>
  );
}
