import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 50, 500));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const q = (url.searchParams.get("q") || "").trim().slice(0, 200);
  const unanalyzedOnly = url.searchParams.get("unanalyzed") === "1";
  if (from && Number.isNaN(Date.parse(from))) {
    return NextResponse.json({ error: "from must be a date string" }, { status: 400 });
  }
  if (to && Number.isNaN(Date.parse(to))) {
    return NextResponse.json({ error: "to must be a date string" }, { status: 400 });
  }
  try {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (unanalyzedOnly) {
      where.push(`analyzed_at IS NULL`);
    }
    if (from) {
      where.push(`COALESCE(posted_at, created_at) >= ?`);
      params.push(new Date(from).toISOString());
    }
    if (to) {
      where.push(`COALESCE(posted_at, created_at) <= ?`);
      params.push(new Date(to).toISOString());
    }
    if (q) {
      where.push(`(title LIKE ? ESCAPE '\\' OR transcript LIKE ? ESCAPE '\\')`);
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const total = (
      getDb().prepare(`SELECT COUNT(*) AS n FROM assets ${whereSql}`).get(...params) as {
        n: number;
      }
    ).n;
    const rows = getDb()
      .prepare(
        `SELECT id, source, title, source_url,
                length(transcript) AS chars,
                analyzed_at, posted_at, created_at, is_reply
         FROM assets ${whereSql}
         ORDER BY COALESCE(posted_at, created_at) DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    return NextResponse.json({ assets: rows, total, limit, offset });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
