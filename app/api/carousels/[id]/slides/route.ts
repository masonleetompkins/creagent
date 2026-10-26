import { NextResponse } from "next/server";
import { addSlide, getProject, isLayout } from "@/lib/carousel";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (body.layout !== undefined && (typeof body.layout !== "string" || !isLayout(body.layout))) {
    return NextResponse.json({ error: "unknown layout" }, { status: 400 });
  }
  try {
    if (!getProject(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
    const slide = addSlide(id, {
      layout: body.layout as string | undefined,
      heading: typeof body.heading === "string" ? body.heading : undefined,
      body: typeof body.body === "string" ? body.body : undefined,
    });
    return NextResponse.json({ slide });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
