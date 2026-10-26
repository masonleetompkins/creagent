import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 50, 200));
  try {
    const rows = getDb()
      .prepare(
        `SELECT id, source, title, source_url,
                length(transcript) AS chars,
                analyzed_at, created_at
         FROM assets ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit);
    return NextResponse.json({ assets: rows });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
