import { NextResponse } from "next/server";
import {
  computeAverages,
  listMetrics,
  listPlatforms,
  scorePosts,
} from "@/lib/metrics";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const platform = url.searchParams.get("platform") || undefined;
  try {
    const platforms = listPlatforms();
    const summaries = platforms.map((p) => {
      const posts = listMetrics(p);
      return { platform: p, averages: computeAverages(posts) };
    });
    const posts = scorePosts(
      listMetrics(platform),
      platform
        ? (summaries.find((s) => s.platform === platform)?.averages ?? {
            count: 0,
            likes: null,
            comments: null,
            shares: null,
            views: null,
          })
        : computeAverages(listMetrics()),
    );
    return NextResponse.json({ platforms: summaries, posts });
  } catch (error) {
    return NextResponse.json(
      { error: `database unavailable: ${(error as Error).message}` },
      { status: 503 },
    );
  }
}
