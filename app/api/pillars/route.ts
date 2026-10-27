import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb, nowIso } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const rows = getDb()
      .prepare(
        `SELECT id, name, description, confirmed, created_at FROM pillars ORDER BY created_at ASC`,
      )
      .all();
    return NextResponse.json({ pillars: rows });
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
  const { name, description } = body as { name?: unknown; description?: unknown };
  if (typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  try {
    const pillar = {
      id: randomUUID(),
      name: name.trim(),
      description: typeof description === "string" ? description : "",
      confirmed: 0,
      created_at: nowIso(),
    };
    getDb()
      .prepare(
        `INSERT INTO pillars (id, name, description, confirmed, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(pillar.id, pillar.name, pillar.description, pillar.confirmed, pillar.created_at);
    return NextResponse.json({ pillar });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
