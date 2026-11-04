import { NextResponse } from "next/server";
import { VIDEO_KINDS } from "@/lib/content";
import { getDb } from "@/lib/db";
import { listSlotMedia, parseMediaPin, resolveSlotMedia } from "@/lib/publish";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Upload picker data for video slots: every candidate file, the current
// pin, and which file actually resolves (auto when unpinned). Candidates
// always ship — even when resolution fails — so the user can re-pick.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const slot = getDb()
      .prepare(`SELECT content_type, approved_media FROM queue_slots WHERE id = ?`)
      .get(id) as { content_type: string; approved_media: string | null } | undefined;
    if (!slot) return NextResponse.json({ error: "slot not found" }, { status: 404 });
    if (!VIDEO_KINDS.has(slot.content_type)) {
      return NextResponse.json({ pin: null, candidates: [], resolved: null });
    }
    const candidates = listSlotMedia(id);
    const media = resolveSlotMedia(id, slot.content_type);
    if ("error" in media) {
      return NextResponse.json({ pin: slot.approved_media, candidates, resolved: null, error: media.error });
    }
    const pin = parseMediaPin(slot.approved_media);
    const match = pin ? (candidates.find((c) => c.source === pin.source && c.id === pin.id) ?? null) : null;
    return NextResponse.json({
      pin: slot.approved_media,
      candidates,
      resolved:
        match && media.source !== "auto"
          ? { source: match.source, id: match.id, label: match.label, url: match.url }
          : { source: "auto" as const, label: media.label },
    });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
