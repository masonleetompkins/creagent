"use client";

import { useEffect, useState } from "react";

export default function BuildStamp({ pageBuild }: { pageBuild: string }): React.ReactNode {
  const short = pageBuild === "dev" ? "dev" : pageBuild.slice(0, 8);
  const [serverBuild, setServerBuild] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/health", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { buildId?: string } | null) => {
        if (alive && d?.buildId) setServerBuild(d.buildId);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const stale = serverBuild !== null && serverBuild !== "dev" && pageBuild !== "dev" && serverBuild !== pageBuild;
  return (
    <span className={`build-stamp${stale ? " stale" : ""}`} title={stale ? "This tab is showing an older build. Hard-refresh to update." : `Running build ${pageBuild}`}>
      <span className="dot" aria-hidden="true" />
      {stale ? (
        <>build {short} · new build ready — press ⇧⌘R</>
      ) : (
        <>build {short}</>
      )}
    </span>
  );
}
