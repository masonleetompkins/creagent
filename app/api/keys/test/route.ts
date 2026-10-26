import { NextResponse } from "next/server";
import { testBrave } from "@/lib/brave";
import { isProvider, loadKeys } from "@/lib/keys";
import { getMetaStatus, metaTextModel, testMetaText } from "@/lib/meta";
import { monidBalance } from "@/lib/monid";
import { testZernio } from "@/lib/zernio";

export const dynamic = "force-dynamic";

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { provider } = body as { provider?: unknown };
  if (typeof provider !== "string" || !isProvider(provider)) {
    return NextResponse.json({ error: "unknown provider" }, { status: 400 });
  }
  const apiKey = loadKeys()[provider];
  if (!apiKey) {
    return NextResponse.json({
      ok: false,
      id: provider,
      message: `Save a ${provider} key first, then test.`,
    });
  }
  try {
    let message: string;
    if (provider === "meta") {
      await getMetaStatus();
      const model = metaTextModel();
      const output = await testMetaText(apiKey, model);
      message = `Connected. Model ${model} replied: ${output}`;
    } else if (provider === "monid") {
      const balance = await monidBalance(apiKey);
      message = `Connected. Balance: ${JSON.stringify(balance).slice(0, 200)}`;
    } else if (provider === "zernio") {
      message = await testZernio(apiKey);
    } else {
      message = await testBrave(apiKey);
    }
    return NextResponse.json({ ok: true, id: provider, message });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      id: provider,
      message: `${provider} check failed: ${messageOf(error)}`,
    });
  }
}
