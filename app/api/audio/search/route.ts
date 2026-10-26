import { NextResponse } from "next/server";
import { searchCommons } from "@/lib/audio";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as { query?: unknown; limit?: unknown };
    if (typeof body.query !== "string" || !body.query.trim()) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }
    const results = await searchCommons(
      body.query.trim(),
      typeof body.limit === "number" ? body.limit : 10,
    );
    return NextResponse.json({ results });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}
