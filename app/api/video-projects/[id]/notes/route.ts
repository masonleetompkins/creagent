import { NextResponse } from "next/server";
import { addNote } from "@/lib/video";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const body = (await request.json()) as { startMs?: unknown; endMs?: unknown; body?: unknown };
    if (typeof body.startMs !== "number" || typeof body.endMs !== "number") {
      return NextResponse.json({ error: "startMs and endMs are required" }, { status: 400 });
    }
    if (typeof body.body !== "string" || !body.body.trim()) {
      return NextResponse.json({ error: "body is required" }, { status: 400 });
    }
    const note = addNote({
      projectId: id,
      startMs: body.startMs,
      endMs: body.endMs,
      body: body.body.trim(),
    });
    return NextResponse.json({ note });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
