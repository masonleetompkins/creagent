import { NextResponse } from "next/server";
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
  const { body: text } = body as { body?: unknown };
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "body must be a non-empty string" }, { status: 400 });
  }
  try {
    const result = getDb()
      .prepare(`UPDATE drafts SET body = ?, status = 'edited' WHERE id = ?`)
      .run(text, id);
    if (result.changes === 0) {
      return NextResponse.json({ error: "draft not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
