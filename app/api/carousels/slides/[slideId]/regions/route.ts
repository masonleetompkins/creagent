import { NextResponse } from "next/server";
import { getSlide } from "@/lib/carousel";
import { slidePhotoUrl } from "@/lib/carousel-image";
import { listRegions } from "@/lib/photo-regions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve the library photo behind a slide's image (if any) and return
// its forbidden-text regions so the renderer can keep copy clear.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slideId: string }> },
): Promise<NextResponse> {
  const { slideId } = await params;
  if (!UUID.test(slideId)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const slide = getSlide(slideId);
    if (!slide) return NextResponse.json({ error: "not found" }, { status: 404 });
    const url = slidePhotoUrl(slide);
    return NextResponse.json({ url, regions: url ? listRegions(url) : [] });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
