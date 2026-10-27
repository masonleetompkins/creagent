import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { loadKeys } from "@/lib/keys";

export const dynamic = "force-dynamic";

// One aggregate for the command-center home: what's due, what needs review,
// pending image-gen approvals, recent agent activity, and setup state.
export async function GET(): Promise<NextResponse> {
  try {
    const db = getDb();
    const horizon = new Date(Date.now() + 36 * 3600 * 1000).toISOString();
    const due = db
      .prepare(
        `SELECT s.id, s.scheduled_at, p.name AS pillar_name, s.content_type,
                s.platforms, s.status,
                (SELECT COUNT(*) FROM drafts d WHERE d.slot_id = s.id) AS draft_count
         FROM queue_slots s LEFT JOIN pillars p ON p.id = s.pillar_id
         WHERE s.status IN ('red', 'orange') AND s.scheduled_at <= ?
         ORDER BY s.scheduled_at ASC LIMIT 8`,
      )
      .all(horizon);
    const review = db
      .prepare(
        `SELECT s.id, s.scheduled_at, p.name AS pillar_name, s.content_type,
                s.platforms,
                (SELECT d.body FROM drafts d WHERE d.slot_id = s.id ORDER BY d.created_at DESC LIMIT 1) AS draft_body,
                (SELECT d.kind FROM drafts d WHERE d.slot_id = s.id ORDER BY d.created_at DESC LIMIT 1) AS draft_kind
         FROM queue_slots s LEFT JOIN pillars p ON p.id = s.pillar_id
         WHERE s.status = 'orange' ORDER BY s.scheduled_at ASC LIMIT 6`,
      )
      .all();
    const genRequests = db
      .prepare(
        `SELECT g.id, g.slot_id, g.project_id, g.kind, g.prompt, g.created_at,
                s.scheduled_at, s.content_type, p.name AS pillar_name
         FROM gen_requests g
         LEFT JOIN queue_slots s ON s.id = g.slot_id
         LEFT JOIN pillars p ON p.id = s.pillar_id
         WHERE g.status = 'pending' ORDER BY g.created_at ASC LIMIT 6`,
      )
      .all();
    const activity = db
      .prepare(
        `SELECT m.content, m.created_at, c.title AS chat_title
         FROM agent_messages m JOIN agent_chats c ON c.id = m.chat_id
         WHERE m.role = 'assistant' ORDER BY m.created_at DESC LIMIT 6`,
      )
      .all();
    const assets = db.prepare(`SELECT COUNT(*) AS n FROM assets`).get() as { n: number };
    const pillars = db.prepare(`SELECT COUNT(*) AS n FROM pillars`).get() as { n: number };
    const keys = loadKeys();
    return NextResponse.json({
      due,
      review,
      genRequests,
      activity,
      setup: {
        assets: assets.n,
        pillars: pillars.n,
        hasMetaKey: keys.meta.length > 0,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
