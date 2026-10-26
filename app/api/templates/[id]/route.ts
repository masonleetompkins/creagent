import { NextResponse } from "next/server";
import { isContentType, PLATFORMS } from "@/lib/content";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

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
  const { name, weekday, time, pillar_id, content_type, platforms } = body as Record<
    string,
    unknown
  >;
  if (weekday !== undefined && (typeof weekday !== "number" || weekday < 0 || weekday > 6)) {
    return NextResponse.json({ error: "weekday must be 0-6" }, { status: 400 });
  }
  if (time !== undefined && (typeof time !== "string" || !TIME.test(time))) {
    return NextResponse.json({ error: "time must be HH:MM" }, { status: 400 });
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
        `UPDATE queue_templates SET
           name = COALESCE(?, name), weekday = COALESCE(?, weekday),
           time = COALESCE(?, time), pillar_id = COALESCE(?, pillar_id),
           content_type = COALESCE(?, content_type), platforms = COALESCE(?, platforms)
         WHERE id = ?`,
      )
      .run(
        typeof name === "string" ? name : null,
        typeof weekday === "number" ? weekday : null,
        typeof time === "string" ? time : null,
        typeof pillar_id === "string" ? pillar_id : null,
        typeof content_type === "string" ? content_type : null,
        platformsJson,
        id,
      );
    if (result.changes === 0) {
      return NextResponse.json({ error: "template not found" }, { status: 404 });
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
    const result = getDb().prepare(`DELETE FROM queue_templates WHERE id = ?`).run(id);
    if (result.changes === 0) {
      return NextResponse.json({ error: "template not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
