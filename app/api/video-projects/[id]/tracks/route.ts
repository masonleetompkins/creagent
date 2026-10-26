import { NextResponse } from "next/server";
import { addTrack, type TrackKind } from "@/lib/video";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: TrackKind[] = ["video", "audio", "caption", "graphics", "review"];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const body = (await request.json()) as { kind?: unknown; name?: unknown };
    if (!KINDS.includes(body.kind as TrackKind)) {
      return NextResponse.json({ error: "kind must be video|audio|caption|graphics|review" }, { status: 400 });
    }
    const track = addTrack(
      id,
      body.kind as TrackKind,
      typeof body.name === "string" ? body.name : undefined,
    );
    return NextResponse.json({ track });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
