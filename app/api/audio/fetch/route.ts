import { NextResponse } from "next/server";
import { fetchCommonsAudio, type AudioKind } from "@/lib/audio";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = (await request.json()) as {
      kind?: unknown;
      title?: unknown;
      url?: unknown;
      size?: unknown;
      duration_ms?: unknown;
      license?: unknown;
      license_url?: unknown;
      artist?: unknown;
      description?: unknown;
    };
    if (body.kind !== "sfx" && body.kind !== "music") {
      return NextResponse.json({ error: "kind must be sfx|music" }, { status: 400 });
    }
    if (typeof body.title !== "string" || typeof body.url !== "string") {
      return NextResponse.json({ error: "title and url are required" }, { status: 400 });
    }
    if (!body.url.startsWith("https://upload.wikimedia.org/")) {
      return NextResponse.json({ error: "only upload.wikimedia.org downloads allowed" }, { status: 400 });
    }
    const entry = await fetchCommonsAudio(body.kind as AudioKind, {
      title: body.title,
      url: body.url,
      size: typeof body.size === "number" ? body.size : null,
      duration_ms: typeof body.duration_ms === "number" ? body.duration_ms : null,
      license: typeof body.license === "string" ? body.license : null,
      license_url: typeof body.license_url === "string" ? body.license_url : null,
      artist: typeof body.artist === "string" ? body.artist : null,
      description: typeof body.description === "string" ? body.description : null,
    });
    return NextResponse.json({ entry });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}
