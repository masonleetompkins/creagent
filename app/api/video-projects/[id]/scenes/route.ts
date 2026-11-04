import { NextResponse } from "next/server";
import { enqueue } from "@/lib/queue";
import { getProjectDetail } from "@/lib/video";
import { collectStatements } from "@/lib/video-scenes";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Auto-graphics: GET counts the spoken statements on the timeline (for the
// spend confirm), POST enqueues the scene build (story-planned anime
// cutaways, one per statement, laid on the Scenes track).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    if (!getProjectDetail(id)) return NextResponse.json({ error: "video project not found" }, { status: 404 });
    const statements = collectStatements(id);
    return NextResponse.json({ statements: statements.length });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    if (!getProjectDetail(id)) return NextResponse.json({ error: "video project not found" }, { status: 404 });
    const jobId = enqueue("video_scenes", { projectId: id });
    return NextResponse.json({ jobId });
  } catch (error) {
    return NextResponse.json(
      { error: `queue unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
