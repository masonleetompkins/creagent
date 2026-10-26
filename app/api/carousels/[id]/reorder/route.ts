import { NextResponse } from "next/server";
import { getProject, listSlides, reorderSlides } from "@/lib/carousel";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { orderedIds } = body as { orderedIds?: unknown };
  if (!Array.isArray(orderedIds) || !orderedIds.every((v): v is string => typeof v === "string")) {
    return NextResponse.json({ error: "orderedIds must be a string array" }, { status: 400 });
  }
  try {
    if (!getProject(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
    reorderSlides(id, orderedIds);
    return NextResponse.json({ slides: listSlides(id) });
  } catch (error) {
    const message = (error as Error).message;
    const status = message.includes("exactly once") ? 400 : 503;
    return NextResponse.json({ error: message }, { status });
  }
}
