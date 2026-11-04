import { NextResponse } from "next/server";
import { createCarouselShellFromSlot } from "@/lib/carousel-copy";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Image Draft: approved slot copy -> project shell instantly, then a
// carousel_build job finishes photos/design/requests while the editor
// shows each stage landing.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const shell = createCarouselShellFromSlot(id);
    const jobId = enqueue("carousel_build", { projectId: shell.projectId });
    return NextResponse.json({ ...shell, jobId });
  } catch (error) {
    const message = (error as Error).message;
    const status =
      message.includes("not found") ? 404
      : message.includes("approve") ? 409
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
