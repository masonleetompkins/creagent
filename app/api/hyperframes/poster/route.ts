import { createReadStream, existsSync, statSync } from "node:fs";
import { NextResponse } from "next/server";
import { posterPath } from "@/lib/hyperframes";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const hash = new URL(request.url).searchParams.get("hash") ?? "";
  if (!/^[0-9a-f]{32}$/.test(hash)) {
    return NextResponse.json({ error: "bad hash" }, { status: 400 });
  }
  const path = posterPath(hash);
  if (!existsSync(path)) return NextResponse.json({ error: "no poster yet" }, { status: 404 });
  const stat = statSync(path);
  const stream = createReadStream(path);
  return new NextResponse(stream as unknown as ReadableStream, {
    headers: { "content-type": "image/png", "content-length": String(stat.size) },
  });
}
