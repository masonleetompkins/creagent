import { NextResponse } from "next/server";
import { listVault } from "@/lib/brain";
import { deleteVaultDoc, searchVault, updateVaultDoc } from "@/lib/vault";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const q = url.searchParams.get("q") || "";
  const type = url.searchParams.get("type") || undefined;
  const limit = Number(url.searchParams.get("limit") || 50);
  try {
    if (q.trim()) {
      const hits = await searchVault(q.trim(), Number.isFinite(limit) ? limit : 50);
      return NextResponse.json({ docs: hits });
    }
    return NextResponse.json({ docs: listVault(type, Number.isFinite(limit) ? limit : 50) });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { id, title, docBody } = body as { id?: unknown; title?: unknown; docBody?: unknown };
  if (typeof id !== "string" || !id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  if (title !== undefined && title !== null && typeof title !== "string") {
    return NextResponse.json({ error: "title must be a string" }, { status: 400 });
  }
  if (docBody !== undefined && typeof docBody !== "string") {
    return NextResponse.json({ error: "docBody must be a string" }, { status: 400 });
  }
  try {
    const ok = await updateVaultDoc(id, {
      title: title === null ? null : typeof title === "string" ? title : undefined,
      body: typeof docBody === "string" ? docBody : undefined,
    });
    if (!ok) return NextResponse.json({ error: "doc not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    if (!deleteVaultDoc(id)) return NextResponse.json({ error: "doc not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
