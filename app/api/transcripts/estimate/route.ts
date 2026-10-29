import { NextResponse } from "next/server";
import { costEstimate } from "@/lib/transcript-backfill";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(costEstimate());
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
