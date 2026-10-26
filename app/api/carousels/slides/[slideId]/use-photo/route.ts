import { NextResponse } from "next/server";
import { downloadPhotoForSlide } from "@/lib/carousel-image";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
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
  const { assetId, url } = body as { assetId?: unknown; url?: unknown };
  if (typeof assetId !== "string" || typeof url !== "string" || !url.startsWith("http")) {
    return NextResponse.json({ error: "assetId and http url are required" }, { status: 400 });
  }
  try {
    const result = await downloadPhotoForSlide(slideId, assetId, url);
    return NextResponse.json(result);
  } catch (error) {
    const message = (error as Error).message;
    const status = message.includes("not found") ? 404 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
