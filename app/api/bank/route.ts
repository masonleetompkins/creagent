import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { bankedCount, bankOption } from "@/lib/bank";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(): Promise<NextResponse> {
  try {
    const items = getDb()
      .prepare(
        `SELECT b.id, b.label, b.content_type, b.status, b.source_draft_id, b.created_at, p.name AS pillar_name
         FROM option_bank b LEFT JOIN pillars p ON p.id = b.pillar_id
         ORDER BY b.created_at DESC LIMIT 50`,
      )
      .all();
    return NextResponse.json({ count: bankedCount(), items });
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
  const { draftId, optionIndex } = body as { draftId?: unknown; optionIndex?: unknown };
  if (typeof draftId !== "string" || !UUID.test(draftId)) {
    return NextResponse.json({ error: "draftId must be a UUID" }, { status: 400 });
  }
  if (typeof optionIndex !== "number" || !Number.isInteger(optionIndex) || optionIndex < 0) {
    return NextResponse.json({ error: "optionIndex must be a non-negative integer" }, { status: 400 });
  }
  try {
    return NextResponse.json({ id: bankOption(draftId, optionIndex) });
  } catch (error) {
    const message = (error as Error).message;
    if (message === "draft not found" || message === "option not found on this draft") {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    return NextResponse.json(
      { error: `database unavailable: ${message}` },
      { status: 503 },
    );
  }
}
