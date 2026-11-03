import { NextResponse } from "next/server";
import { fillBanked } from "@/lib/bank";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  try {
    const { placed, skipped } = fillBanked();
    return NextResponse.json({ placed, skipped });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
