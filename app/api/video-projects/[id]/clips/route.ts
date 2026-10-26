import { NextResponse } from "next/server";
import { addClip } from "@/lib/video";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  void id;
  try {
    const body = (await request.json()) as {
      trackId?: unknown;
      assetId?: unknown;
      name?: unknown;
      inMs?: unknown;
      durationMs?: unknown;
      atMs?: unknown;
      payload?: unknown;
    };
    if (typeof body.trackId !== "string" || !UUID.test(body.trackId)) {
      return NextResponse.json({ error: "trackId is required" }, { status: 400 });
    }
    if (typeof body.durationMs !== "number" || body.durationMs <= 0) {
      return NextResponse.json({ error: "durationMs must be positive" }, { status: 400 });
    }
    const clip = addClip({
      trackId: body.trackId,
      assetId: typeof body.assetId === "string" ? body.assetId : null,
      name: typeof body.name === "string" ? body.name : undefined,
      inMs: typeof body.inMs === "number" ? body.inMs : undefined,
      durationMs: body.durationMs,
      atMs: typeof body.atMs === "number" ? body.atMs : undefined,
      payload:
        body.payload !== null && typeof body.payload === "object"
          ? (body.payload as Record<string, unknown>)
          : undefined,
    });
    return NextResponse.json({ clip });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
