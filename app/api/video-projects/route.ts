import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb, nowIso } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const rows = getDb()
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM video_tracks t WHERE t.project_id = p.id) AS track_count
         FROM video_projects p ORDER BY p.updated_at DESC`,
      )
      .all();
    return NextResponse.json({ projects: rows });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  try {
    const ts = nowIso();
    const row = {
      id: randomUUID(),
      slot_id: typeof body.slot_id === "string" ? body.slot_id : null,
      title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : "Untitled video",
      width: typeof body.width === "number" ? body.width : 1080,
      height: typeof body.height === "number" ? body.height : 1920,
      fps: typeof body.fps === "number" ? body.fps : 30,
      created_at: ts,
      updated_at: ts,
    };
    getDb()
      .prepare(
        `INSERT INTO video_projects (id, slot_id, title, width, height, fps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.slot_id, row.title, row.width, row.height, row.fps, row.created_at, row.updated_at);
    // Default track stack: keyed subject over graphics over main video, plus audio.
    const tracks: Array<[string, string, number]> = [
      ["video", "Subject (keyed)", 0],
      ["graphics", "Graphics", 1],
      ["video", "Main", 2],
      ["audio", "Audio", 3],
      ["caption", "Captions", 4],
      ["review", "Review", 5],
    ];
    const insertTrack = getDb().prepare(
      `INSERT INTO video_tracks (id, project_id, kind, name, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [kind, name, position] of tracks) {
      insertTrack.run(randomUUID(), row.id, kind, name, position, ts);
    }
    return NextResponse.json({ project: row });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
