import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { checkDb } from "@/lib/db";
import { loadKeys } from "@/lib/keys";
import { checkQueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

function readBuildId(): string {
  try {
    return readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    return "dev";
  }
}

// Captured once when the server process loads this module: this is the build
// the RUNNING code came from. (Reading the file per request would report a
// newer build that was compiled under a stale server — the exact failure
// where health claimed "current" while serving old pages.)
const BOOT_BUILD_ID = readBuildId();

export async function GET(): Promise<NextResponse> {
  const keys = loadKeys();
  return NextResponse.json({
    ok: true,
    buildId: BOOT_BUILD_ID,
    diskBuildId: readBuildId(),
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
