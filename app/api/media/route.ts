import { NextResponse } from "next/server";
import { listMedia } from "@/lib/media";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") || undefined;
  if (kind && !["video", "audio", "image"].includes(kind)) {
    return NextResponse.json({ error: "bad kind" }, { status: 400 });
  }
  try {
    return NextResponse.json({ media: listMedia(kind) });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
