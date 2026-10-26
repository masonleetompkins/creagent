import { NextResponse } from "next/server";
import { saveMediaUpload } from "@/lib/media";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
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
    const asset = await saveMediaUpload(file);
    return NextResponse.json({ asset });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
