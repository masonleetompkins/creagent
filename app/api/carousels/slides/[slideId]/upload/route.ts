import { NextResponse } from "next/server";
import { saveUploadForSlide } from "@/lib/carousel-image";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slideId: string }> },
): Promise<NextResponse> {
  const { slideId } = await params;
  if (!UUID.test(slideId)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart form data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "no file uploaded" }, { status: 400 });
  }
  try {
    const result = await saveUploadForSlide(slideId, file);
    return NextResponse.json(result);
  } catch (error) {
    const message = (error as Error).message;
    const status = message === "slide not found" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
