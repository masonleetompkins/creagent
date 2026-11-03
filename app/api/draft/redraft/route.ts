import { NextResponse } from "next/server";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request): Promise<NextResponse> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  try {
    if (typeof body.slotId !== "string" || !UUID.test(body.slotId)) {
      return NextResponse.json({ error: "slotId must be a UUID" }, { status: 400 });
    }
    if (typeof body.feedback !== "string" || !body.feedback.trim()) {
      return NextResponse.json({ error: "feedback is empty" }, { status: 400 });
    }
    const mode = body.mode === "set" ? "set" : "refine";
    const standing = body.standing === true;
    const jobId = enqueue("redraft_slot", {
      slotId: body.slotId,
      feedback: body.feedback.trim().slice(0, 4000),
      mode,
      standing,
    });
    return NextResponse.json({ jobId });
  } catch (error) {
    return NextResponse.json(
      { error: `queue unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
