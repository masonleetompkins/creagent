import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hintsDir(): string {
  const dir = join(homedir(), ".config", "creagent", "key-hints");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  void id;
  try {
    let clipId = "";
    let hintPath: string | undefined;
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const rawClip = form.get("clipId");
      if (typeof rawClip !== "string" || !UUID.test(rawClip)) {
        return NextResponse.json({ error: "clipId is required" }, { status: 400 });
      }
      clipId = rawClip;
      const hint = form.get("hint");
      if (hint instanceof File && hint.size > 0) {
        hintPath = join(hintsDir(), `${randomUUID()}.png`);
        writeFileSync(hintPath, Buffer.from(await hint.arrayBuffer()));
      }
    } else {
      const body = (await request.json()) as { clipId?: unknown; hintPath?: unknown };
      if (typeof body.clipId !== "string" || !UUID.test(body.clipId)) {
        return NextResponse.json({ error: "clipId is required" }, { status: 400 });
      }
      clipId = body.clipId;
      if (typeof body.hintPath === "string" && body.hintPath) hintPath = body.hintPath;
    }
    const jobId = enqueue("key_clip", { clipId, hintPath });
    return NextResponse.json({ jobId });
  } catch (error) {
    return NextResponse.json(
      { error: `queue unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
