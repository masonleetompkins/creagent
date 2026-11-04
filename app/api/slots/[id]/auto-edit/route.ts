import { NextResponse } from "next/server";
import { findOrCreateVideoProject, VIDEO_SLOT_TYPES } from "@/lib/autoedit";
import { getDb } from "@/lib/db";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Agent autonomy: cut attached footage for a video slot (transcribe,
// auto-cut takes, lay keeps on Main) and flag the slot for review.
// Returns the linked project instantly so the UI can navigate and watch
// the job land live in the editor.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const slot = getDb()
      .prepare(`SELECT id, content_type, scheduled_at FROM queue_slots WHERE id = ?`)
      .get(id) as { id: string; content_type: string; scheduled_at: string } | undefined;
    if (!slot) return NextResponse.json({ error: "slot not found" }, { status: 404 });
    if (!VIDEO_SLOT_TYPES.includes(slot.content_type)) {
      return NextResponse.json({ error: "auto-edit needs a video slot" }, { status: 400 });
    }
    const date = new Date(slot.scheduled_at).toLocaleDateString();
    const projectId = findOrCreateVideoProject(id, `Video — ${slot.content_type} — ${date}`);
    const jobId = enqueue("video_autoedit", { slotId: id });
    return NextResponse.json({ projectId, jobId });
  } catch (error) {
    return NextResponse.json(
      { error: `queue unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
