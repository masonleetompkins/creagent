import { NextResponse } from "next/server";
import { clearCaptions, generateCaptions, listCaptions } from "@/lib/captions";
import { getTranscript } from "@/lib/transcribe";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    return NextResponse.json({ captions: listCaptions(id) });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const body = (await request.json()) as {
      assetId?: unknown;
      wordsPerLine?: unknown;
      maxLines?: unknown;
      replace?: unknown;
    };
    if (typeof body.assetId !== "string" || !UUID.test(body.assetId)) {
      return NextResponse.json({ error: "assetId is required" }, { status: 400 });
    }
    const { transcript, words } = getTranscript(body.assetId);
    if (!transcript) {
      return NextResponse.json({ error: "transcribe the footage first" }, { status: 409 });
    }
    if (body.replace === true) clearCaptions(id);
    const captions = generateCaptions(id, body.assetId, words, {
      wordsPerLine: typeof body.wordsPerLine === "number" ? body.wordsPerLine : undefined,
      maxLines: typeof body.maxLines === "number" ? body.maxLines : undefined,
    });
    return NextResponse.json({ captions });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    return NextResponse.json(clearCaptions(id));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
