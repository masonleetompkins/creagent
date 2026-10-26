import { NextResponse } from "next/server";
import { applyTakesToTrack, detectTakes, getTakesByAsset, saveTakes } from "@/lib/autocut";
import { getTranscript } from "@/lib/transcribe";

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
    const body = (await request.json()) as { assetId?: unknown };
    if (typeof body.assetId !== "string" || !UUID.test(body.assetId)) {
      return NextResponse.json({ error: "assetId is required" }, { status: 400 });
    }
    const { transcript, words } = getTranscript(body.assetId);
    if (!transcript) {
      return NextResponse.json({ error: "transcribe the footage first" }, { status: 409 });
    }
    const takes = saveTakes(transcript.id, detectTakes(words));
    return NextResponse.json({ transcriptId: transcript.id, takes });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  void id;
  const assetId = new URL(request.url).searchParams.get("assetId") ?? "";
  if (!UUID.test(assetId)) return NextResponse.json({ error: "assetId is required" }, { status: 400 });
  try {
    return NextResponse.json(getTakesByAsset(assetId));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  void id;
  try {
    const body = (await request.json()) as { trackId?: unknown; assetId?: unknown };
    if (typeof body.trackId !== "string" || !UUID.test(body.trackId)) {
      return NextResponse.json({ error: "trackId is required" }, { status: 400 });
    }
    if (typeof body.assetId !== "string" || !UUID.test(body.assetId)) {
      return NextResponse.json({ error: "assetId is required" }, { status: 400 });
    }
    const { takes } = getTakesByAsset(body.assetId);
    if (takes.length === 0) {
      return NextResponse.json({ error: "run auto-cut first" }, { status: 409 });
    }
    return NextResponse.json(applyTakesToTrack(body.trackId, body.assetId, takes));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
