import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { checkDb } from "@/lib/db";
import { loadKeys } from "@/lib/keys";
import { checkQueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

function buildId(): string {
  try {
    return readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    return "dev";
  }
}

export async function GET(): Promise<NextResponse> {
  const keys = loadKeys();
  return NextResponse.json({
    ok: true,
    buildId: buildId(),
    db: checkDb(),
    queue: checkQueue(),
    keys: {
      meta: keys.meta.length > 0,
      monid: keys.monid.length > 0,
      zernio: keys.zernio.length > 0,
      brave: keys.brave.length > 0,
    },
  });
}
