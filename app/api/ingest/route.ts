import { NextResponse } from "next/server";
import { isIngestSource } from "@/lib/ingest";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { source, value } = body as { source?: unknown; value?: unknown };
  if (typeof source !== "string" || !isIngestSource(source)) {
    return NextResponse.json({ error: "unknown ingest source" }, { status: 400 });
  }
  if (typeof value !== "string" || !value.trim()) {
    return NextResponse.json({ error: "ingest input is empty" }, { status: 400 });
  }
  try {
    const jobId = enqueue("ingest", { source, value: value.trim() });
    return NextResponse.json({ jobId });
  } catch (error) {
    return NextResponse.json(
      { error: `queue unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
