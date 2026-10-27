import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 50, 500));
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from && Number.isNaN(Date.parse(from))) {
    return NextResponse.json({ error: "from must be a date string" }, { status: 400 });
  }
  if (to && Number.isNaN(Date.parse(to))) {
    return NextResponse.json({ error: "to must be a date string" }, { status: 400 });
  }
  try {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (from) {
      where.push(`COALESCE(posted_at, created_at) >= ?`);
      params.push(new Date(from).toISOString());
    }
    if (to) {
      where.push(`COALESCE(posted_at, created_at) <= ?`);
      params.push(new Date(to).toISOString());
    }
    params.push(limit);
    const rows = getDb()
      .prepare(
        `SELECT id, source, title, source_url,
                length(transcript) AS chars,
                analyzed_at, posted_at, created_at
         FROM assets ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY COALESCE(posted_at, created_at) DESC LIMIT ?`,
      )
      .all(...params);
    return NextResponse.json({ assets: rows });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
