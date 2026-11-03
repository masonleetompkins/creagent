import { NextResponse } from "next/server";
import { loadKeys } from "@/lib/keys";
import { cancelScheduled, publishSlot, slotPublishHistory, syncSlot } from "@/lib/publish";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// User-only publish: the click IS the approval, so no agent tool routes
// here. POST sends (future slots schedule, due slots post now) or cancels
// via { action: "cancel" }. Preflight/config failures come back as HTTP
// errors; an attempted send always returns 200 with per-platform receipts
// (ok:false when any platform didn't finish).
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const key = loadKeys().zernio;
  if (!key) {
    return NextResponse.json({ error: "save a Zernio key in Settings first" }, { status: 400 });
  }
  let action = "send";
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body["action"] === "string") action = body["action"];
  } catch {
    /* empty body means send */
  }
  try {
    if (action === "cancel") {
      const result = await cancelScheduled(id, key);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });
      return NextResponse.json(result);
    }
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
  // Lazy sync: opening the inspector lands scheduled posts that went live
  // since the last check. Best-effort — history still returns on failure.
  const key = loadKeys().zernio;
  if (key) {
    try {
      await syncSlot(id, key);
    } catch {
      /* worker sweep retries shortly */
    }
  }
  try {
    return NextResponse.json({ history: slotPublishHistory(id) });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
