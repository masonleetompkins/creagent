import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { extractPoster, hfHash, renderHyperframes } from "@/lib/hyperframes";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Render a Hyperframes graphics clip to cached .mov (draft) and return a
// poster hash for the preview. Export re-renders at delivery quality.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const body = (await request.json()) as { clipId?: unknown };
    if (typeof body.clipId !== "string" || !UUID.test(body.clipId)) {
      return NextResponse.json({ error: "clipId is required" }, { status: 400 });
    }
    const db = getDb();
    const project = db
      .prepare(`SELECT width, height, fps FROM video_projects WHERE id = ?`)
      .get(id) as { width: number; height: number; fps: number } | undefined;
    if (!project) return NextResponse.json({ error: "project not found" }, { status: 404 });
    const clip = db
      .prepare(
        `SELECT c.duration_ms, c.payload FROM video_clips c
         JOIN video_tracks t ON t.id = c.track_id
         WHERE c.id = ? AND t.project_id = ? AND t.kind = 'graphics'`,
      )
      .get(body.clipId, id) as { duration_ms: number; payload: string } | undefined;
    if (!clip) return NextResponse.json({ error: "graphics clip not found" }, { status: 404 });
    let payload: { kind?: unknown; html?: unknown } = {};
    try {
      payload = JSON.parse(clip.payload) as { kind?: unknown; html?: unknown };
    } catch {
      return NextResponse.json({ error: "clip has no composition" }, { status: 400 });
    }
    if (payload.kind !== "hyperframes" || typeof payload.html !== "string" || !payload.html.trim()) {
      return NextResponse.json({ error: "clip is not a Hyperframes composition" }, { status: 400 });
    }
    const opts = {
      width: project.width,
      height: project.height,
      fps: project.fps,
      durationMs: clip.duration_ms,
      quality: "draft",
    };
    const mov = renderHyperframes(payload.html, opts);
    const hash = hfHash(payload.html, opts);
    extractPoster(mov, hash);
    return NextResponse.json({ hash });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}
