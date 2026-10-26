import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isContentType, PLATFORMS } from "@/lib/content";
import { getDb, nowIso } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? new Date(0).toISOString();
  const to =
    url.searchParams.get("to") ?? new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  try {
    const rows = getDb()
      .prepare(
        `SELECT s.id, s.scheduled_at, s.pillar_id, p.name AS pillar_name,
                s.content_type, s.platforms, s.status, s.brief, s.created_at,
                (SELECT COUNT(*) FROM drafts d WHERE d.slot_id = s.id) AS draft_count
         FROM queue_slots s LEFT JOIN pillars p ON p.id = s.pillar_id
         WHERE s.scheduled_at >= ? AND s.scheduled_at <= ?
         ORDER BY s.scheduled_at ASC`,
      )
      .all(from, to);
    return NextResponse.json({ slots: rows });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { scheduled_at, pillar_id, content_type, platforms } = body as Record<string, unknown>;
  if (typeof scheduled_at !== "string" || Number.isNaN(Date.parse(scheduled_at))) {
    return NextResponse.json({ error: "scheduled_at must be an ISO date" }, { status: 400 });
  }
  if (typeof content_type !== "string" || !isContentType(content_type)) {
    return NextResponse.json({ error: "unknown content_type" }, { status: 400 });
  }
  const allowed = new Set<string>([...PLATFORMS]);
  const clean =
    Array.isArray(platforms)
      ? platforms.filter((p): p is string => typeof p === "string" && allowed.has(p))
      : [];
  try {
    const row = {
      id: randomUUID(),
      scheduled_at: new Date(scheduled_at).toISOString(),
      pillar_id: typeof pillar_id === "string" ? pillar_id : null,
      content_type,
      platforms: JSON.stringify(clean),
      created_at: nowIso(),
    };
    getDb()
      .prepare(
        `INSERT INTO queue_slots (id, scheduled_at, pillar_id, content_type, platforms, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'red', ?)`,
      )
      .run(row.id, row.scheduled_at, row.pillar_id, row.content_type, row.platforms, row.created_at);
    return NextResponse.json({ slot: { ...row, status: "red" } });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
