import { NextResponse } from "next/server";
import { createProject, listProjects } from "@/lib/carousel";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ projects: listProjects() });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  try {
    const project = createProject({
      title: typeof body.title === "string" ? body.title : undefined,
      slot_id: typeof body.slot_id === "string" ? body.slot_id : null,
    });
    return NextResponse.json({ project });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
