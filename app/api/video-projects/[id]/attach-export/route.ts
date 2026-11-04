import { NextResponse } from "next/server";
import { attachExportToSlot } from "@/lib/export";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Copy a finished export onto the project's queue slot (ships on publish).
export async function POST(
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
  const { exportId } = body as { exportId?: unknown };
  if (typeof exportId !== "string" || !UUID.test(exportId)) {
    return NextResponse.json({ error: "exportId is required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await attachExportToSlot(id, exportId));
  } catch (error) {
    const message = (error as Error).message;
    const status =
      message.includes("not found") || message.includes("gone") ? 404
      : message.includes("not linked") ? 409
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
