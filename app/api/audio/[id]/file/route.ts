import { createReadStream, existsSync, statSync } from "node:fs";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const entry = getDb()
      .prepare(`SELECT local_path FROM audio_library WHERE id = ?`)
      .get(id) as { local_path: string | null } | undefined;
    if (!entry?.local_path || !existsSync(entry.local_path)) {
      return NextResponse.json({ error: "file not downloaded" }, { status: 404 });
    }
    const stat = statSync(entry.local_path);
    const stream = createReadStream(entry.local_path);
    return new NextResponse(stream as unknown as ReadableStream, {
      headers: {
        "content-type": "audio/mpeg",
        "content-length": String(stat.size),
        "accept-ranges": "bytes",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
