import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const slot = getDb()
      .prepare(
        `SELECT s.id, s.scheduled_at, s.pillar_id, p.name AS pillar_name,
                s.content_type, s.platforms, s.status, s.created_at
         FROM queue_slots s LEFT JOIN pillars p ON p.id = s.pillar_id
         WHERE s.id = ?`,
      )
      .get(id);
    if (!slot) return NextResponse.json({ error: "slot not found" }, { status: 404 });
    const drafts = getDb()
      .prepare(
        `SELECT id, kind, body, status, created_at FROM drafts
         WHERE slot_id = ? ORDER BY created_at ASC`,
      )
      .all(id);
    return NextResponse.json({ slot, drafts });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
