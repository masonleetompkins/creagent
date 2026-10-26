import { NextResponse } from "next/server";
import { deleteClip, moveClip, trimClip, updateClipPayload } from "@/lib/video";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ clipId: string }> },
): Promise<NextResponse> {
  const { clipId } = await params;
  if (!UUID.test(clipId)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const body = (await request.json()) as {
      inMs?: unknown;
      durationMs?: unknown;
      startMs?: unknown;
      ripple?: unknown;
      payload?: unknown;
    };
    const ripple = body.ripple !== false;
    if (body.payload !== undefined) {
      if (body.payload === null || typeof body.payload !== "object") {
        return NextResponse.json({ error: "payload must be an object" }, { status: 400 });
      }
      const clip = updateClipPayload(clipId, body.payload as Record<string, unknown>);
      if (!clip) return NextResponse.json({ error: "not found" }, { status: 404 });
      return NextResponse.json({ clip });
    }
    if (typeof body.startMs === "number") {
      return NextResponse.json({ clip: moveClip(clipId, body.startMs) });
    }
    if (typeof body.inMs !== "number" && typeof body.durationMs !== "number") {
      return NextResponse.json({ error: "inMs, durationMs, or startMs required" }, { status: 400 });
    }
    const clip = trimClip(
      clipId,
      {
        inMs: typeof body.inMs === "number" ? body.inMs : undefined,
        durationMs: typeof body.durationMs === "number" ? body.durationMs : undefined,
      },
      ripple,
    );
    return NextResponse.json({ clip });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ clipId: string }> },
): Promise<NextResponse> {
  const { clipId } = await params;
  if (!UUID.test(clipId)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const ripple = new URL(request.url).searchParams.get("ripple") !== "0";
    const result = deleteClip(clipId, ripple);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
