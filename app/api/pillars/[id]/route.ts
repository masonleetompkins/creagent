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
  const { name, description, confirmed } = body as {
    name?: unknown;
    description?: unknown;
    confirmed?: unknown;
  };
  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    return NextResponse.json({ error: "name must be a non-empty string" }, { status: 400 });
  }
  if (description !== undefined && typeof description !== "string") {
    return NextResponse.json({ error: "description must be a string" }, { status: 400 });
  }
  if (confirmed !== undefined && typeof confirmed !== "boolean") {
    return NextResponse.json({ error: "confirmed must be a boolean" }, { status: 400 });
  }
  try {
    const db = getDb();
    if (confirmed === true) {
      const count = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM pillars WHERE confirmed = 1 AND id != ?`)
          .get(id) as { n: number }
      ).n;
      if (count >= 5) {
        return NextResponse.json({ error: "at most 5 confirmed pillars" }, { status: 400 });
      }
    }
    const result = db
      .prepare(
        `UPDATE pillars
         SET name = COALESCE(?, name),
             description = COALESCE(?, description),
             confirmed = COALESCE(?, confirmed)
         WHERE id = ?`,
      )
      .run(
        typeof name === "string" ? name.trim() : null,
        typeof description === "string" ? description : null,
        typeof confirmed === "boolean" ? (confirmed ? 1 : 0) : null,
        id,
      );
    if (result.changes === 0) {
      return NextResponse.json({ error: "pillar not found" }, { status: 404 });
    }
    const pillar = db
      .prepare(
        `SELECT id, name, description, confirmed, created_at FROM pillars WHERE id = ?`,
      )
      .get(id);
    return NextResponse.json({ pillar });
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
    const result = getDb().prepare(`DELETE FROM pillars WHERE id = ?`).run(id);
    if (result.changes === 0) {
      return NextResponse.json({ error: "pillar not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
