import { NextResponse } from "next/server";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let days = 14;
  try {
    const body = (await request.json()) as { days?: unknown };
    if (typeof body.days === "number") days = Math.max(1, Math.min(body.days, 30));
  } catch {
    /* defaults */
  }
  try {
    const jobId = enqueue("plan", { days });
    return NextResponse.json({ jobId });
  } catch (error) {
    return NextResponse.json(
      { error: `queue unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
