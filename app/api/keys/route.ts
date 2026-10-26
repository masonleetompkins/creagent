import { NextResponse } from "next/server";
import {
  PROVIDERS,
  Provider,
  isProvider,
  loadKeys,
  maskKey,
  saveKey,
} from "@/lib/keys";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const keys = loadKeys();
  const providers = PROVIDERS.map((p: Provider) => ({
    id: p,
    set: keys[p].length > 0,
    masked: maskKey(keys[p]),
  }));
  return NextResponse.json({ providers });
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { provider, key } = body as { provider?: unknown; key?: unknown };
  if (typeof provider !== "string" || !isProvider(provider)) {
    return NextResponse.json({ error: "unknown provider" }, { status: 400 });
  }
  if (typeof key !== "string") {
    return NextResponse.json({ error: "key must be a string" }, { status: 400 });
  }
  saveKey(provider, key);
  return NextResponse.json({
    ok: true,
    id: provider,
    set: key.trim().length > 0,
    masked: maskKey(key.trim()),
  });
}
