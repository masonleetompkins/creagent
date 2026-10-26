import { NextResponse } from "next/server";
import { createChat, listChats } from "@/lib/agent";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ chats: listChats() });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let title = "New chat";
  try {
    const body = (await request.json()) as { title?: unknown };
    if (typeof body.title === "string" && body.title.trim()) title = body.title.trim();
  } catch {
    /* default */
  }
  try {
    return NextResponse.json({ chatId: createChat(title) });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
