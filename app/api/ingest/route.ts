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
  const { source, value, since, until, maxPages } = body as {
    source?: unknown;
    value?: unknown;
    since?: unknown;
    until?: unknown;
    maxPages?: unknown;
  };
  if (typeof source !== "string" || !isIngestSource(source)) {
    return NextResponse.json({ error: "unknown ingest source" }, { status: 400 });
  }
  if (typeof value !== "string" || !value.trim()) {
    return NextResponse.json({ error: "ingest input is empty" }, { status: 400 });
  }
  for (const [name, v] of [
    ["since", since],
    ["until", until],
  ] as const) {
    if (v !== undefined && (typeof v !== "string" || Number.isNaN(Date.parse(v)))) {
      return NextResponse.json({ error: `${name} must be a date string` }, { status: 400 });
    }
  }
  try {
    const jobId = enqueue("ingest", {
      source,
      value: value.trim(),
      since: typeof since === "string" ? since : undefined,
      until: typeof until === "string" ? until : undefined,
      maxPages:
        typeof maxPages === "number" ? Math.max(0, Math.min(Math.round(maxPages), 500)) : undefined,
    });
    return NextResponse.json({ jobId });
  } catch (error) {
    return NextResponse.json(
      { error: `queue unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
