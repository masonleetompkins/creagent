import { NextResponse } from "next/server";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as { batch?: unknown };
    const batch =
      typeof body.batch === "number" && Number.isFinite(body.batch)
        ? Math.max(1, Math.min(Math.floor(body.batch), 1000))
        : 100;
    const jobId = enqueue("transcribe_backfill", { limit: batch });
    return NextResponse.json({ jobId });
  } catch (error) {
    return NextResponse.json(
      { error: `queue unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
