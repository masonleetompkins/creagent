import { NextResponse } from "next/server";
import { addLocalAudio, listAudio, type AudioKind } from "@/lib/audio";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const kind = new URL(request.url).searchParams.get("kind") || undefined;
  if (kind && kind !== "sfx" && kind !== "music") {
    return NextResponse.json({ error: "bad kind" }, { status: 400 });
  }
  try {
    return NextResponse.json({ audio: listAudio(kind as AudioKind | undefined) });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as { kind?: unknown; path?: unknown; title?: unknown };
    if (body.kind !== "sfx" && body.kind !== "music") {
      return NextResponse.json({ error: "kind must be sfx|music" }, { status: 400 });
    }
    if (typeof body.path !== "string" || !body.path) {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }
    const entry = addLocalAudio(
      body.kind,
      body.path,
      typeof body.title === "string" ? body.title : undefined,
    );
    return NextResponse.json({ entry });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
