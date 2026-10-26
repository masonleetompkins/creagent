import { NextResponse } from "next/server";
import {
  deleteProject,
  getProject,
  isHexColor,
  listSlides,
  updateProject,
} from "@/lib/carousel";
import { listForProject } from "@/lib/gen-requests";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FONTS = new Set([
  "system-black",
  "system",
  "arial-black",
  "helvetica",
  "georgia",
  "archivo-black",
  "anton",
  "bebas-neue",
  "montserrat",
  "oswald",
  "playfair",
  "inter",
  "roboto",
  "lora",
]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    const project = getProject(id);
    if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({
      project,
      slides: listSlides(id),
      gen_requests: listForProject(id),
    });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}

export async function PATCH(
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
  const patch = body as Record<string, unknown>;
  for (const key of ["primary_color", "secondary_color", "background_color"]) {
    if (patch[key] !== undefined && (typeof patch[key] !== "string" || !isHexColor(patch[key] as string))) {
      return NextResponse.json({ error: `${key} must be #rrggbb` }, { status: 400 });
    }
  }
  for (const key of ["heading_font", "body_font"]) {
    if (patch[key] !== undefined && (typeof patch[key] !== "string" || !FONTS.has(patch[key] as string))) {
      return NextResponse.json({ error: `unknown ${key}` }, { status: 400 });
    }
  }
  try {
    const project = updateProject(id, {
      title: typeof patch.title === "string" ? patch.title : undefined,
      primary_color: patch.primary_color as string | undefined,
      secondary_color: patch.secondary_color as string | undefined,
      background_color: patch.background_color as string | undefined,
      heading_font: patch.heading_font as string | undefined,
      body_font: patch.body_font as string | undefined,
      slot_id: typeof patch.slot_id === "string" ? patch.slot_id : undefined,
    });
    if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ project });
  } catch (error) {
    const message = (error as Error).message;
    const status = message.includes("must be") ? 400 : 503;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try {
    if (!deleteProject(id)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
