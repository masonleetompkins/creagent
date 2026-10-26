import { NextResponse } from "next/server";
import { usedRanges } from "@/lib/video";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const assetId = new URL(request.url).searchParams.get("assetId") ?? "";
  if (!UUID.test(assetId)) {
    return NextResponse.json({ error: "assetId is required" }, { status: 400 });
  }
  try {
    return NextResponse.json({ ranges: usedRanges(id, assetId) });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
