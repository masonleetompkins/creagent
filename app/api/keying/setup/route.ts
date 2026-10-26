import { NextResponse } from "next/server";
import { setupState } from "@/lib/corridorkey";
import { enqueue } from "@/lib/queue";

export const dynamic = "force-dynamic";

// One-click CorridorKey install: runs scripts/setup-corridorkey.sh in the
// background worker. Poll GET /api/keying/status for setup state.
export async function POST(): Promise<NextResponse> {
  try {
    const current = setupState();
    if (current.state === "ready") return NextResponse.json({ state: "ready", jobId: null });
    if (current.state === "installing") {
      return NextResponse.json({ state: "installing", jobId: null });
    }
    const jobId = enqueue("keying_setup", {});
    return NextResponse.json({ state: "installing", jobId });
  } catch (error) {
    return NextResponse.json(
      { error: `queue unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
