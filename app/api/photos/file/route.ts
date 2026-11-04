import { NextResponse } from "next/server";
import { readLocalPhoto } from "@/lib/photos";

export const dynamic = "force-dynamic";

// Serves uploaded library photos keyed `local:<file>`.
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url).searchParams.get("url") ?? "";
  const hit = readLocalPhoto(url);
  if (!hit) return NextResponse.json({ error: "photo not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(hit.data), {
    status: 200,
    headers: {
      "Content-Type": hit.mime,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
