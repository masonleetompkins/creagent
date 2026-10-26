import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isContentType, PLATFORMS } from "@/lib/content";
import { getDb, nowIso } from "@/lib/db";

export const dynamic = "force-dynamic";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanPlatforms(value: unknown): string[] | null {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>([...PLATFORMS]);
  const out = value.filter((p): p is string => typeof p === "string" && allowed.has(p));
  return out;
}

export async function GET(): Promise<NextResponse> {
  try {
    const rows = getDb()
      .prepare(
        `SELECT t.id, t.name, t.weekday, t.time, t.pillar_id, p.name AS pillar_name,
                t.content_type, t.platforms, t.created_at
         FROM queue_templates t LEFT JOIN pillars p ON p.id = t.pillar_id
         ORDER BY t.weekday, t.time`,
      )
      .all();
    return NextResponse.json({ templates: rows });
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
  const { name, weekday, time, pillar_id, content_type, platforms } = body as Record<
    string,
    unknown
  >;
  if (typeof weekday !== "number" || weekday < 0 || weekday > 6 || !Number.isInteger(weekday)) {
    return NextResponse.json({ error: "weekday must be an integer 0-6" }, { status: 400 });
  }
  if (typeof time !== "string" || !TIME.test(time)) {
    return NextResponse.json({ error: "time must be HH:MM" }, { status: 400 });
  }
  if (typeof content_type !== "string" || !isContentType(content_type)) {
    return NextResponse.json({ error: "unknown content_type" }, { status: 400 });
  }
  if (pillar_id !== undefined && pillar_id !== null && typeof pillar_id !== "string") {
    return NextResponse.json({ error: "pillar_id must be a string" }, { status: 400 });
  }
  try {
    const row = {
      id: randomUUID(),
      name: typeof name === "string" ? name : "",
      weekday,
      time,
      pillar_id: typeof pillar_id === "string" ? pillar_id : null,
      content_type,
      platforms: JSON.stringify(cleanPlatforms(platforms) ?? []),
      created_at: nowIso(),
    };
    getDb()
      .prepare(
        `INSERT INTO queue_templates (id, name, weekday, time, pillar_id, content_type, platforms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.name, row.weekday, row.time, row.pillar_id, row.content_type, row.platforms, row.created_at);
    return NextResponse.json({ template: row });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
