import { NextResponse } from "next/server";
import { splitClip } from "@/lib/video";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ clipId: string }> },
): Promise<NextResponse> {
  const { clipId } = await params;
  if (!UUID.test(clipId)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const body = (await request.json()) as { atMs?: unknown };
    if (typeof body.atMs !== "number") {
      return NextResponse.json({ error: "atMs is required" }, { status: 400 });
    }
    const result = splitClip(clipId, body.atMs);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
