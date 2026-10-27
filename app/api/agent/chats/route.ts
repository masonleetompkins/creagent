import { NextResponse } from "next/server";
import { createChat, listChats, reorderChats } from "@/lib/agent";

export async function PATCH(request: Request): Promise<NextResponse> {
  let order: string[] = [];
  try {
    const body = (await request.json()) as { order?: unknown };
    if (Array.isArray(body.order)) order = body.order.filter((x): x is string => typeof x === "string");
  } catch {
    return NextResponse.json({ error: "order is required" }, { status: 400 });
  }
  if (order.length === 0) return NextResponse.json({ error: "order is required" }, { status: 400 });
  try {
    reorderChats(order);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}

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
