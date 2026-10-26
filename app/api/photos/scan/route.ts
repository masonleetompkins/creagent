import { NextResponse } from "next/server";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let limit = 30;
  try {
    const body = (await request.json()) as { limit?: unknown };
    if (typeof body.limit === "number") limit = Math.max(1, Math.min(body.limit, 100));
  } catch {
    /* defaults */
  }
  try {
    const jobId = enqueue("photo_scan", { limit });
    return NextResponse.json({ jobId });
  } catch (error) {
    return NextResponse.json(
      { error: `queue unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
