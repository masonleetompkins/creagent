import { NextResponse } from "next/server";
import { deletePhoto, listPhotos } from "@/lib/photos";
import { updatePhotoTag } from "@/lib/photo-vision";
import { listRegions } from "@/lib/photo-regions";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const photos = listPhotos();
    const tags = getDb()
      .prepare(`SELECT url, description, tags, suggested FROM photo_tags`)
      .all() as Array<{ url: string; description: string; tags: string; suggested: string }>;
    const byUrl = new Map(tags.map((t) => [t.url, t]));
    return NextResponse.json({
      photos: photos.map((p) => ({
        ...p,
        tag: byUrl.get(p.url) ?? null,
        regions: listRegions(p.url),
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}

// Correct an LLM label: updates text and re-embeds so autopick matches
// the correction.
export async function PATCH(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { url, description, tags, suggested } = body as {
    url?: unknown; description?: unknown; tags?: unknown; suggested?: unknown;
  };
  if (typeof url !== "string" || !url) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }
  if (description !== undefined && typeof description !== "string") {
    return NextResponse.json({ error: "description must be a string" }, { status: 400 });
  }
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== "string"))) {
    return NextResponse.json({ error: "tags must be a string array" }, { status: 400 });
  }
  if (suggested !== undefined && typeof suggested !== "string") {
    return NextResponse.json({ error: "suggested must be a string" }, { status: 400 });
  }
  try {
    const tag = await updatePhotoTag(url, {
      description: description as string | undefined,
      tags: tags as string[] | undefined,
      suggested: suggested as string | undefined,
    });
    return NextResponse.json({ tag });
  } catch (error) {
    const message = (error as Error).message;
    const status = message.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

// Delete a photo forever: uploads leave the disk, ingested URLs join the
// hide list so they never resurface.
export async function DELETE(request: Request): Promise<NextResponse> {
  const url = new URL(request.url).searchParams.get("url") ?? "";
  if (!url) return NextResponse.json({ error: "url query is required" }, { status: 400 });
  try {
    return NextResponse.json(deletePhoto(url));
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
