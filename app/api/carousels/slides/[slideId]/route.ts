import { NextResponse } from "next/server";
import { deleteSlide, isLayout, updateSlide } from "@/lib/carousel";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slideId: string }> },
): Promise<NextResponse> {
  const { slideId } = await params;
  if (!UUID.test(slideId)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const patch = body as Record<string, unknown>;
  if (patch.layout !== undefined && (typeof patch.layout !== "string" || !isLayout(patch.layout))) {
    return NextResponse.json({ error: "unknown layout" }, { status: 400 });
  }
  try {
    const slide = updateSlide(slideId, {
      layout: patch.layout as string | undefined,
      heading: typeof patch.heading === "string" ? patch.heading : undefined,
      body: typeof patch.body === "string" ? patch.body : undefined,
      image_prompt: typeof patch.image_prompt === "string" ? patch.image_prompt : undefined,
    });
    if (!slide) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ slide });
  } catch (error) {
    const message = (error as Error).message;
    const status = message.includes("unknown") ? 400 : 503;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slideId: string }> },
): Promise<NextResponse> {
  const { slideId } = await params;
  if (!UUID.test(slideId)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    if (!deleteSlide(slideId)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
