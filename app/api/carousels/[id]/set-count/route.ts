import { NextResponse } from "next/server";
import { addSlide, deleteSlide, getProject, listSlides } from "@/lib/carousel";

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
  const { count } = body as { count?: unknown };
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 15) {
    return NextResponse.json({ error: "count must be an integer 1-15" }, { status: 400 });
  }
  try {
    if (!getProject(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
    const slides = listSlides(id);
    if (count > slides.length) {
      for (let i = slides.length; i < count; i++) addSlide(id, {});
    } else {
      for (const s of slides.slice(count)) deleteSlide(s.id);
    }
    return NextResponse.json({ slides: listSlides(id) });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
