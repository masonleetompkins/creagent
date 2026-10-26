import { NextResponse } from "next/server";
import { getRequest, setRequestStatus } from "@/lib/gen-requests";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Approving spends image credits: enqueue the real generation and mark approved.
// The worker flips the request to done when the image lands.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const req = getRequest(id);
    if (!req) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (req.status !== "pending") {
      return NextResponse.json({ error: `already ${req.status}` }, { status: 409 });
    }
    if (!req.slide_id) return NextResponse.json({ error: "request has no slide" }, { status: 400 });
    const jobId = enqueue("carousel_image", {
      slideId: req.slide_id,
      prompt: req.prompt,
      requestId: req.id,
    });
    setRequestStatus(req.id, "approved");
    return NextResponse.json({ jobId });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
