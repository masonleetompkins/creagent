import { NextResponse } from "next/server";
import { listPhotos } from "@/lib/photos";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const photos = listPhotos();
    const tags = getDb()
      .prepare(`SELECT url, description, tags FROM photo_tags`)
      .all() as Array<{ url: string; description: string; tags: string }>;
    const byUrl = new Map(tags.map((t) => [t.url, t]));
    return NextResponse.json({
      photos: photos.map((p) => ({
        ...p,
        tag: byUrl.get(p.url) ?? null,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
