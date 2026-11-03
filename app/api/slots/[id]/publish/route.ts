import { NextResponse } from "next/server";
import { loadKeys } from "@/lib/keys";
import { publishSlot, slotPublishHistory } from "@/lib/publish";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// User-only publish: the click IS the approval, so no agent tool routes
// here. Preflight/config failures come back as HTTP errors; an attempted
// send always returns 200 with per-platform receipts (ok:false when any
// platform didn't publish).
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const key = loadKeys().zernio;
  if (!key) {
    return NextResponse.json({ error: "save a Zernio key in Settings first" }, { status: 400 });
  }
  try {
    const result = await publishSlot(id, key);
    if (!result.ok && !result.receipts) {
      return NextResponse.json({ error: result.error }, { status: 422 });
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: `publish unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    return NextResponse.json({ history: slotPublishHistory(id) });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
