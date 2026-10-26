// Carousel project + slide CRUD over the embedded store.
import { randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";

export type CarouselProject = {
  id: string;
  slot_id: string | null;
  title: string;
  primary_color: string;
  secondary_color: string;
  background_color: string;
  heading_font: string;
  body_font: string;
  created_at: string;
  updated_at: string;
};

export type CarouselSlide = {
  id: string;
  project_id: string;
  position: number;
  layout: string;
  heading: string;
  body: string;
  image_path: string | null;
  image_source: string | null;
  image_prompt: string | null;
  created_at: string;
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const LAYOUTS = new Set(["cover", "content", "photo", "cta"]);

export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

export function isLayout(value: string): boolean {
  return LAYOUTS.has(value);
}

export function listProjects(): Array<CarouselProject & { slide_count: number }> {
  return getDb()
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM carousel_slides s WHERE s.project_id = p.id) AS slide_count
       FROM carousel_projects p ORDER BY p.updated_at DESC`,
    )
    .all() as Array<CarouselProject & { slide_count: number }>;
}

export function getProject(id: string): CarouselProject | null {
  return (
    (getDb().prepare(`SELECT * FROM carousel_projects WHERE id = ?`).get(id) as
      | CarouselProject
      | undefined) ?? null
  );
}

export function createProject(input: {
  title?: string;
  slot_id?: string | null;
}): CarouselProject {
  const ts = nowIso();
  const row: CarouselProject = {
    id: randomUUID(),
    slot_id: input.slot_id ?? null,
    title: input.title?.trim() || "Untitled carousel",
    primary_color: "#0b5fff",
    secondary_color: "#111111",
    background_color: "#ffffff",
    heading_font: "system-black",
    body_font: "system",
    created_at: ts,
    updated_at: ts,
  };
  getDb()
    .prepare(
      `INSERT INTO carousel_projects
       (id, slot_id, title, primary_color, secondary_color, background_color, heading_font, body_font, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id, row.slot_id, row.title, row.primary_color, row.secondary_color,
      row.background_color, row.heading_font, row.body_font, row.created_at, row.updated_at,
    );
  return row;
}

export function updateProject(
  id: string,
  patch: Partial<
    Pick<
      CarouselProject,
      | "title"
      | "primary_color"
      | "secondary_color"
      | "background_color"
      | "heading_font"
      | "body_font"
      | "slot_id"
    >
  >,
): CarouselProject | null {
  const db = getDb();
  const sets: string[] = ["updated_at = ?"];
  const vals: unknown[] = [nowIso()];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (
      (key === "primary_color" || key === "secondary_color" || key === "background_color") &&
      (typeof value !== "string" || !isHexColor(value))
    ) {
      throw new Error(`${key} must be a #rrggbb hex color`);
    }
    sets.push(`${key} = ?`);
    vals.push(value);
  }
  vals.push(id);
  const result = db
    .prepare(`UPDATE carousel_projects SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(vals as Array<string | null>));
  if (result.changes === 0) return null;
  return getProject(id);
}

export function deleteProject(id: string): boolean {
  const result = getDb().prepare(`DELETE FROM carousel_projects WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function getSlide(id: string): CarouselSlide | null {
  return (
    (getDb().prepare(`SELECT * FROM carousel_slides WHERE id = ?`).get(id) as
      | CarouselSlide
      | undefined) ?? null
  );
}

export function listSlides(projectId: string): CarouselSlide[] {
  return getDb()
    .prepare(`SELECT * FROM carousel_slides WHERE project_id = ? ORDER BY position ASC`)
    .all(projectId) as CarouselSlide[];
}

export function addSlide(
  projectId: string,
  input: { layout?: string; heading?: string; body?: string } = {},
): CarouselSlide {
  const db = getDb();
  const max = db
    .prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM carousel_slides WHERE project_id = ?`)
    .get(projectId) as { m: number };
  const row: CarouselSlide = {
    id: randomUUID(),
    project_id: projectId,
    position: max.m + 1,
    layout: input.layout && isLayout(input.layout) ? input.layout : "content",
    heading: input.heading ?? "",
    body: input.body ?? "",
    image_path: null,
    image_source: null,
    image_prompt: null,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO carousel_slides
     (id, project_id, position, layout, heading, body, image_path, image_source, image_prompt, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.project_id, row.position, row.layout, row.heading, row.body,
    row.image_path, row.image_source, row.image_prompt, row.created_at,
  );
  touchProject(projectId);
  return row;
}

export function updateSlide(
  id: string,
  patch: Partial<Pick<CarouselSlide, "layout" | "heading" | "body" | "image_path" | "image_source" | "image_prompt">>,
): CarouselSlide | null {
  const db = getDb();
  if (patch.layout !== undefined && !isLayout(patch.layout)) {
    throw new Error("unknown layout");
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    vals.push(value);
  }
  if (sets.length === 0) {
    return (db.prepare(`SELECT * FROM carousel_slides WHERE id = ?`).get(id) as CarouselSlide | undefined) ?? null;
  }
  vals.push(id);
  const result = db
    .prepare(`UPDATE carousel_slides SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(vals as Array<string | null>));
  if (result.changes === 0) return null;
  const row = db.prepare(`SELECT * FROM carousel_slides WHERE id = ?`).get(id) as CarouselSlide;
  touchProject(row.project_id);
  return row;
}

export function deleteSlide(id: string): CarouselSlide | null {
  const db = getDb();
  const row = (db.prepare(`SELECT * FROM carousel_slides WHERE id = ?`).get(id) as CarouselSlide | undefined) ?? null;
  if (!row) return null;
  db.prepare(`DELETE FROM carousel_slides WHERE id = ?`).run(id);
  // Compact positions.
  const rest = db
    .prepare(`SELECT id FROM carousel_slides WHERE project_id = ? ORDER BY position ASC`)
    .all(row.project_id) as Array<{ id: string }>;
  const upd = db.prepare(`UPDATE carousel_slides SET position = ? WHERE id = ?`);
  rest.forEach((r, i) => upd.run(i, r.id));
  touchProject(row.project_id);
  return row;
}

export function reorderSlides(projectId: string, orderedIds: string[]): void {
  const db = getDb();
  const existing = new Set(
    (db.prepare(`SELECT id FROM carousel_slides WHERE project_id = ?`).all(projectId) as Array<{ id: string }>).map(
      (r) => r.id,
    ),
  );
  if (orderedIds.length !== existing.size || !orderedIds.every((id) => existing.has(id))) {
    throw new Error("orderedIds must list every slide exactly once");
  }
  const upd = db.prepare(`UPDATE carousel_slides SET position = ? WHERE id = ?`);
  orderedIds.forEach((id, i) => upd.run(i, id));
  touchProject(projectId);
}

function touchProject(projectId: string): void {
  getDb().prepare(`UPDATE carousel_projects SET updated_at = ? WHERE id = ?`).run(nowIso(), projectId);
}
