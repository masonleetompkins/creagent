import { NextResponse } from "next/server";
import { isContentType, isSlotStatus, PLATFORMS } from "@/lib/content";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { status, scheduled_at, pillar_id, content_type, platforms } = body as Record<
    string,
    unknown
  >;
  if (status !== undefined && (typeof status !== "string" || !isSlotStatus(status))) {
    return NextResponse.json({ error: "unknown status" }, { status: 400 });
  }
  if (
    scheduled_at !== undefined &&
    (typeof scheduled_at !== "string" || Number.isNaN(Date.parse(scheduled_at)))
  ) {
    return NextResponse.json({ error: "scheduled_at must be an ISO date" }, { status: 400 });
  }
  if (content_type !== undefined && (typeof content_type !== "string" || !isContentType(content_type))) {
    return NextResponse.json({ error: "unknown content_type" }, { status: 400 });
  }
  let platformsJson: string | null = null;
  if (platforms !== undefined) {
    if (!Array.isArray(platforms)) {
      return NextResponse.json({ error: "platforms must be an array" }, { status: 400 });
    }
    const allowed = new Set<string>([...PLATFORMS]);
    platformsJson = JSON.stringify(
      platforms.filter((p): p is string => typeof p === "string" && allowed.has(p)),
    );
  }
  try {
    const result = getDb()
      .prepare(
        `UPDATE queue_slots SET
           status = COALESCE(?, status), scheduled_at = COALESCE(?, scheduled_at),
           pillar_id = COALESCE(?, pillar_id), content_type = COALESCE(?, content_type),
           platforms = COALESCE(?, platforms)
         WHERE id = ?`,
      )
      .run(
        typeof status === "string" ? status : null,
        typeof scheduled_at === "string" ? new Date(scheduled_at).toISOString() : null,
        typeof pillar_id === "string" ? pillar_id : null,
        typeof content_type === "string" ? content_type : null,
        platformsJson,
        id,
      );
    if (result.changes === 0) {
      return NextResponse.json({ error: "slot not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const result = getDb().prepare(`DELETE FROM queue_slots WHERE id = ?`).run(id);
    if (result.changes === 0) {
      return NextResponse.json({ error: "slot not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
