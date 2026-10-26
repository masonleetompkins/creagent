import { NextResponse } from "next/server";
import { readSlideImage } from "@/lib/carousel-image";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slideId: string }> },
): Promise<NextResponse> {
  const { slideId } = await params;
  if (!UUID.test(slideId)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const { data, filename } = await readSlideImage(slideId);
    const bytes = new Uint8Array(data);
    const mime = filename.endsWith(".jpg")
      ? "image/jpeg"
      : filename.endsWith(".webp")
        ? "image/webp"
        : "image/png";
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": mime,
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (error) {
    const status = /no image|not found|ENOENT/.test((error as Error).message) ? 404 : 500;
    return NextResponse.json({ error: (error as Error).message }, { status });
  }
}
