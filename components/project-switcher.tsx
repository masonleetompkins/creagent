"use client";

import { useCallback, useEffect, useState } from "react";

type Project = { id: string; title: string };

export default function ProjectSwitcher({
  kind,
  currentId,
}: {
  kind: "carousel" | "video";
  currentId: string;
}): React.ReactNode {
  const [projects, setProjects] = useState<Project[]>([]);
  const base = kind === "carousel" ? "/carousels" : "/videos";
  const api = kind === "carousel" ? "/api/carousels" : "/api/video-projects";
  const label = kind === "carousel" ? "carousel" : "video";

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(api);
      if (res.ok) setProjects((((await res.json()) as { projects: Project[] }).projects ?? []));
    } catch {
      /* list stays empty */
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create(): Promise<void> {
    const res = await fetch(api, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) return;
    const project = ((await res.json()) as { project: Project }).project;
    window.location.href = `${base}/${project.id}`;
  }

  async function remove(): Promise<void> {
    const current = projects.find((p) => p.id === currentId);
    if (!window.confirm(`Delete this ${label} ("${current?.title ?? "untitled"}")?`)) return;
    const res = await fetch(`${api}/${currentId}`, { method: "DELETE" });
    if (res.ok) window.location.href = base;
  }

  return (
    <div className="toolbar switcher">
      <select
        aria-label={`Switch ${label}`}
        value={currentId}
        onChange={(e) => {
          if (e.target.value !== currentId) window.location.href = `${base}/${e.target.value}`;
        }}
      >
        {projects.length === 0 ? <option value={currentId}>Loading…</option> : null}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
          </option>
        ))}
      </select>
      <button onClick={() => void create()}>New</button>
      <button onClick={() => void remove()}>Delete</button>
    </div>
  );
}
