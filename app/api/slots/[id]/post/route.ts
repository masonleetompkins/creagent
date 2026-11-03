import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { hasLiveScheduled } from "@/lib/publish";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The user clicks Posted when the content is live. The slot goes gray and
// stays in place as history.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  // Marking posted while Zernio still holds a scheduled copy would fire it
  // on top of the manual post — cancel there first (mirrors the UI guard).
  try {
    if (hasLiveScheduled(id)) {
      return NextResponse.json(
        { error: "still scheduled on Zernio — cancel the scheduled post first" },
        { status: 422 },
      );
    }
  } catch {
    /* schedule check is best-effort; the manual mark stands */
  }
  try {
    const result = getDb()
      .prepare(`UPDATE queue_slots SET status = 'gray' WHERE id = ? AND status != 'gray'`)
      .run(id);
    if (result.changes === 0) {
      return NextResponse.json({ error: "slot not found or already posted" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
