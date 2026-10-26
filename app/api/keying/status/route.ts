import { NextResponse } from "next/server";
import { keyStatus } from "@/lib/corridorkey";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await keyStatus());
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
