import { NextResponse } from "next/server";
import { draftCarouselFromSlot } from "@/lib/carousel-copy";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Image Draft: approved slot copy -> carousel slides -> matched photos.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const result = await draftCarouselFromSlot(id);
    return NextResponse.json(result);
  } catch (error) {
    const message = (error as Error).message;
    const status =
      message.includes("not found") ? 404
      : message.includes("approve") ? 409
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
