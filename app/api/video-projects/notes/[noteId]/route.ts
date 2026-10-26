import { NextResponse } from "next/server";
import { deleteNote, setNoteStatus } from "@/lib/video";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ noteId: string }> },
): Promise<NextResponse> {
  const { noteId } = await params;
  if (!UUID.test(noteId)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const body = (await request.json()) as { status?: unknown };
    if (body.status !== "open" && body.status !== "done") {
      return NextResponse.json({ error: "status must be open|done" }, { status: 400 });
    }
    setNoteStatus(noteId, body.status);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ noteId: string }> },
): Promise<NextResponse> {
  const { noteId } = await params;
  if (!UUID.test(noteId)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    deleteNote(noteId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
