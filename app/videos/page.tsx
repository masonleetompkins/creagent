"use client";

import { useEffect, useState } from "react";

type Project = { id: string; title: string; updated_at: string; track_count: number };

export default function VideosPage(): React.ReactNode {
  const [projects, setProjects] = useState<Project[]>([]);
  const [title, setTitle] = useState("");

  useEffect(() => {
    void fetch("/api/video-projects")
      .then((r) => r.json())
      .then((d) => setProjects((d as { projects: Project[] }).projects ?? []));
  }, []);

  return (
    <div>
      <h1>Videos</h1>
      <div className="row">
        <input
          type="text"
          placeholder="New project title…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button
          className="primary"
          onClick={async () => {
            const res = await fetch("/api/video-projects", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ title: title.trim() || "Untitled video" }),
            });
            if (res.ok) {
              const data = (await res.json()) as { project: Project };
              window.location.href = `/videos/${data.project.id}`;
            }
          }}
        >
          New project
        </button>
      </div>
      {projects.map((p) => (
        <p key={p.id}>
          <a href={`/videos/${p.id}`}>{p.title}</a>{" "}
          <span className="muted">
            · {p.track_count} tracks · {p.updated_at.slice(0, 10)}
          </span>
        </p>
      ))}
      {projects.length === 0 && <p className="muted">No video projects yet.</p>}
    </div>
  );
}
