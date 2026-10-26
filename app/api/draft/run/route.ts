import { NextResponse } from "next/server";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  try {
    if (typeof body.slotId === "string" && body.slotId) {
      const jobId = enqueue("draft_slot", { slotId: body.slotId });
      return NextResponse.json({ jobId });
    }
    const limit =
      typeof body.limit === "number" ? Math.max(1, Math.min(body.limit, 25)) : 10;
    const jobId = enqueue("draft_all", { limit });
    return NextResponse.json({ jobId });
  } catch (error) {
    return NextResponse.json(
      { error: `queue unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
