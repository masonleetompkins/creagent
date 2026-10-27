import { NextResponse } from "next/server";
import { loadKeys } from "@/lib/keys";
import { zernioAccounts } from "@/lib/zernio";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const keys = loadKeys();
    if (!keys.zernio) return NextResponse.json({ error: "save a Zernio key in Settings first" }, { status: 400 });
    return NextResponse.json({ accounts: await zernioAccounts(keys.zernio) });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
}
