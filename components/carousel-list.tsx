"use client";

import { useCallback, useEffect, useState } from "react";

type Project = {
  id: string;
  title: string;
  slide_count: number;
  updated_at: string;
};

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) ?? `HTTP ${res.status}`);
  return data;
}

export default function CarouselList(): React.ReactNode {
  const [projects, setProjects] = useState<Project[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await readJson(await fetch("/api/carousels"));
      setProjects((data.projects as Project[]) ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create(): Promise<void> {
    try {
      const data = await readJson(
        await fetch("/api/carousels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        }),
      );
      const project = data.project as Project;
      window.location.href = `/carousels/${project.id}`;
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string): Promise<void> {
    if (!window.confirm("Delete this carousel and all its slides?")) return;
    try {
      await readJson(await fetch(`/api/carousels/${id}`, { method: "DELETE" }));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      {error ? <p className="note err">{error}</p> : null}
      <section className="keycard">
        <h2>New carousel</h2>
        <div className="row">
          <input
            type="text"
            aria-label="Carousel title"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button className="primary" onClick={() => void create()}>
            Create
          </button>
        </div>
      </section>
      {projects.map((p) => (
        <section className="keycard" key={p.id}>
          <h2>
            <a href={`/carousels/${p.id}`}>{p.title}</a>
            <span className="status unset">
              {p.slide_count} slide{p.slide_count === 1 ? "" : "s"}
            </span>
          </h2>
          <div className="row">
            <button onClick={() => void remove(p.id)}>Delete</button>
          </div>
        </section>
      ))}
      {projects.length === 0 ? <p className="muted">No carousels yet.</p> : null}
    </>
  );
}
