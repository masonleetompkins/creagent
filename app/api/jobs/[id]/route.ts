import { NextResponse } from "next/server";
import { getJob } from "@/lib/queue";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  try {
    const job = getJob(id);
    if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
    return NextResponse.json({
      id: job.id,
      name: job.name,
      state: job.state,
      progress: job.progress,
      result: job.result,
      failedReason: job.failedReason,
    });
  } catch (error) {
    return NextResponse.json(
      { error: `queue unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
