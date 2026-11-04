import { NextResponse } from "next/server";
import { MAX_PHOTO_UPLOAD_BYTES, savePhotoUpload } from "@/lib/photos";

export const dynamic = "force-dynamic";

// Batch upload into the photo LIBRARY (not a slide): files land on disk,
// each gets an empty label row, then "Analyze photos" classifies them.
export async function POST(request: Request): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "multipart body with file fields is required" }, { status: 400 });
  }
  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "no files attached" }, { status: 400 });
  }
  if (files.length > 20) {
    return NextResponse.json({ error: "at most 20 files per upload" }, { status: 400 });
  }
  const urls: string[] = [];
  const failures: Array<{ name: string; error: string }> = [];
  for (const file of files) {
    if (!file.type.startsWith("image/")) {
      failures.push({ name: file.name, error: "not an image" });
      continue;
    }
    try {
      const { url } = await savePhotoUpload(file);
      urls.push(url);
    } catch (error) {
      failures.push({ name: file.name, error: (error as Error).message });
    }
  }
  return NextResponse.json(
    { urls, failures, capBytes: MAX_PHOTO_UPLOAD_BYTES },
    { status: failures.length > 0 && urls.length === 0 ? 400 : 200 },
  );
}
