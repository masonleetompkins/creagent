import { NextResponse } from "next/server";
import { getMessages } from "@/lib/agent";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    return NextResponse.json({ messages: getMessages(id) });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  let message = "";
  try {
    const body = (await request.json()) as { message?: unknown };
    if (typeof body.message === "string") message = body.message;
  } catch {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }
  if (!message.trim()) return NextResponse.json({ error: "message is required" }, { status: 400 });
  try {
    const jobId = enqueue("agent_turn", { chatId: id, message: message.trim().slice(0, 8000) });
    return NextResponse.json({ jobId });
  } catch (error) {
    return NextResponse.json(
      { error: `queue unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
