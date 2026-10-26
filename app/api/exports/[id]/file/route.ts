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
    const row = getDb()
      .prepare(`SELECT path FROM video_exports WHERE id = ?`)
      .get(id) as { path: string } | undefined;
    if (!row || !existsSync(row.path)) {
      return NextResponse.json({ error: "export not found" }, { status: 404 });
    }
    const stat = statSync(row.path);
    const stream = createReadStream(row.path);
    return new NextResponse(stream as unknown as ReadableStream, {
      headers: {
        "content-type": "video/mp4",
        "content-length": String(stat.size),
        "content-disposition": `attachment; filename="creagent-export-${id.slice(0, 8)}.mp4"`,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
