import { NextResponse } from "next/server";
import { getRequest, setRequestStatus } from "@/lib/gen-requests";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    setRequestStatus(req.id, "rejected");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
