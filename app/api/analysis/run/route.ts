import { NextResponse } from "next/server";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let limit: number | undefined;
  try {
    const body = (await request.json()) as { limit?: unknown };
    if (typeof body.limit === "number") limit = body.limit;
  } catch {
    limit = undefined;
  }
  try {
    const jobId = enqueue("analyze", { limit });
    return NextResponse.json({ jobId });
  } catch (error) {
    return NextResponse.json(
      { error: `queue unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
