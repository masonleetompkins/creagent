import { NextResponse } from "next/server";
import { audioToTimeline, deleteAudio } from "@/lib/audio";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const body = (await request.json()) as { projectId?: unknown; atMs?: unknown };
    if (typeof body.projectId !== "string" || !UUID.test(body.projectId)) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }
    const result = audioToTimeline(
      id,
      body.projectId,
      typeof body.atMs === "number" ? body.atMs : undefined,
    );
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    if (!deleteAudio(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
