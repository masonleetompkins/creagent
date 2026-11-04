import { NextResponse } from "next/server";
import { restoreClips, type ClipSnapshot } from "@/lib/video";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const body = (await request.json()) as { clips?: unknown };
    if (!Array.isArray(body.clips)) {
      return NextResponse.json({ error: "clips must be an array" }, { status: 400 });
    }
    const result = restoreClips(id, body.clips as ClipSnapshot[]);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "restore failed" },
      { status: 400 },
    );
  }
}
