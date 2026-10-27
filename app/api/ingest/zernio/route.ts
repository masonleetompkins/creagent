import { NextResponse } from "next/server";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { accountIds, since, until } = body as {
    accountIds?: unknown;
    since?: unknown;
    until?: unknown;
  };
  if (
    !Array.isArray(accountIds) ||
    accountIds.length === 0 ||
    !accountIds.every((a): a is string => typeof a === "string" && a.trim().length > 0)
  ) {
    return NextResponse.json({ error: "accountIds must be a non-empty string array" }, { status: 400 });
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
    const jobId = enqueue("ingest_zernio", {
      accountIds,
      since: typeof since === "string" ? since : undefined,
      until: typeof until === "string" ? until : undefined,
    });
    return NextResponse.json({ jobId });
  } catch (error) {
    return NextResponse.json(
      { error: `queue unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
