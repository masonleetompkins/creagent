import { NextResponse } from "next/server";
import {
  blockWords,
  deleteCaption,
  listCaptions,
  moveWordAcrossLines,
  reflowLines,
  splitCaption,
  updateCaption,
  type CaptionLine,
} from "@/lib/captions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ capId: string }> },
): Promise<NextResponse> {
  const { capId } = await params;
  if (!UUID.test(capId)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const body = (await request.json()) as {
      start_ms?: unknown;
      end_ms?: unknown;
      enabled?: unknown;
      lines?: unknown;
    };
    let lines: CaptionLine[] | undefined;
    if (body.lines !== undefined) {
      if (!Array.isArray(body.lines)) {
        return NextResponse.json({ error: "lines must be an array" }, { status: 400 });
      }
      lines = [];
      for (const l of body.lines as Array<{ text?: unknown; start_ms?: unknown; end_ms?: unknown }>) {
        if (typeof l?.text !== "string") {
          return NextResponse.json({ error: "each line needs text" }, { status: 400 });
        }
        lines.push({
          text: l.text,
          start_ms: typeof l.start_ms === "number" ? l.start_ms : 0,
          end_ms: typeof l.end_ms === "number" ? l.end_ms : 0,
        });
      }
    }
    const block = updateCaption(capId, {
      start_ms: typeof body.start_ms === "number" ? body.start_ms : undefined,
      end_ms: typeof body.end_ms === "number" ? body.end_ms : undefined,
      enabled: body.enabled === 0 || body.enabled === false ? 0 : body.enabled === 1 || body.enabled === true ? 1 : undefined,
      lines,
    });
    if (!block) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ caption: block });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ capId: string }> },
): Promise<NextResponse> {
  const { capId } = await params;
  if (!UUID.test(capId)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const body = (await request.json()) as {
      action?: unknown;
      atLine?: unknown;
      wordsPerLine?: unknown;
      lineIndex?: unknown;
      wordIndex?: unknown;
      dir?: unknown;
      projectId?: unknown;
    };
    if (body.action === "split") {
      if (typeof body.atLine !== "number") {
        return NextResponse.json({ error: "atLine is required" }, { status: 400 });
      }
      const result = splitCaption(capId, body.atLine);
      if (!result) return NextResponse.json({ error: "cannot split there" }, { status: 400 });
      return NextResponse.json(result);
    }
    // reflow and move-word need the current block; projectId scopes the lookup.
    if (typeof body.projectId !== "string" || !UUID.test(body.projectId)) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }
    const block = listCaptions(body.projectId).find((b) => b.id === capId);
    if (!block) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (body.action === "reflow") {
      if (typeof body.wordsPerLine !== "number" || body.wordsPerLine < 1) {
        return NextResponse.json({ error: "wordsPerLine must be >= 1" }, { status: 400 });
      }
      const lines = reflowLines(block.lines, blockWords(block), Math.floor(body.wordsPerLine));
      return NextResponse.json({ caption: updateCaption(capId, { lines }) });
    }
    if (body.action === "move-word") {
      if (
        typeof body.lineIndex !== "number" ||
        typeof body.wordIndex !== "number" ||
        (body.dir !== -1 && body.dir !== 1)
      ) {
        return NextResponse.json({ error: "lineIndex, wordIndex, dir (-1|1) required" }, { status: 400 });
      }
      const lines = moveWordAcrossLines(block.lines, body.lineIndex, body.wordIndex, body.dir);
      return NextResponse.json({ caption: updateCaption(capId, { lines }) });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ capId: string }> },
): Promise<NextResponse> {
  const { capId } = await params;
  if (!UUID.test(capId)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    if (!deleteCaption(capId)) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
