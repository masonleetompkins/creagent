import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { updateDraftOption, updateDraftThreadBody } from "@/lib/drafting";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const {
    body: text,
    selection,
    optionIndex,
    threadBody,
  } = body as {
    body?: unknown;
    selection?: unknown;
    optionIndex?: unknown;
    threadBody?: unknown;
  };
  if (selection !== undefined && typeof selection !== "string") {
    return NextResponse.json({ error: "selection must be a string" }, { status: 400 });
  }
  if (text !== undefined && (typeof text !== "string" || !text.trim())) {
    return NextResponse.json({ error: "body must be a non-empty string" }, { status: 400 });
  }
  if (threadBody !== undefined && (typeof threadBody !== "string" || !threadBody.trim())) {
    return NextResponse.json({ error: "threadBody must be a non-empty string" }, { status: 400 });
  }
  if (
    optionIndex !== undefined &&
    (typeof optionIndex !== "number" || !Number.isInteger(optionIndex))
  ) {
    return NextResponse.json({ error: "optionIndex must be an integer" }, { status: 400 });
  }
  // Scoped edits keep the structure (other options survive); whole-body
  // edits still clear it to clean prose.
  if (optionIndex !== undefined || threadBody !== undefined) {
    try {
      if (optionIndex !== undefined) {
        if (typeof text !== "string") {
          return NextResponse.json({ error: "body is required with optionIndex" }, { status: 400 });
        }
        updateDraftOption(id, optionIndex, text);
      } else {
        updateDraftThreadBody(id, threadBody as string);
      }
      return NextResponse.json({ ok: true });
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("not found")) {
        return NextResponse.json({ error: message }, { status: 404 });
      }
      return NextResponse.json({ error: message }, { status: 422 });
    }
  }
  if (text === undefined && selection === undefined) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  try {
    // Manual body edits diverge from the code-assembled structure, so the
    // structure is cleared — the draft renders as clean prose from here on.
    const result = getDb()
      .prepare(
        `UPDATE drafts SET body = COALESCE(?, body), selection = COALESCE(?, selection),
                status = CASE WHEN ? IS NOT NULL THEN 'edited' ELSE status END,
                structure = CASE WHEN ? IS NOT NULL THEN NULL ELSE structure END
         WHERE id = ?`,
      )
      .run(
        typeof text === "string" ? text : null,
        typeof selection === "string" ? selection : null,
        typeof text === "string" ? text : null,
        typeof text === "string" ? text : null,
        id,
      );
    if (result.changes === 0) {
      return NextResponse.json({ error: "draft not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
