import { NextResponse } from "next/server";
import { listVault } from "@/lib/brain";
import { searchVault } from "@/lib/vault";

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
