import { NextResponse } from "next/server";
import { addRegion, deleteRegion, listRegions } from "@/lib/photo-regions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url).searchParams.get("url") ?? "";
  if (!url) return NextResponse.json({ error: "url query is required" }, { status: 400 });
  try {
    return NextResponse.json({ regions: listRegions(url) });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { url, x, y, w, h, label } = body as {
    url?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown; label?: unknown;
  };
  if (typeof url !== "string" || !url) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }
  try {
    const region = addRegion(url, {
      x: x as number, y: y as number, w: w as number, h: h as number,
      label: typeof label === "string" ? label : undefined,
    });
    return NextResponse.json({ region });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    if (!deleteRegion(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
