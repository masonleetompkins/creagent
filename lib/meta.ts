import OpenAI from "openai";

export const META_BASE_URL = "https://api.meta.ai/v1";
// Contributor tier: ~12x cheaper ($0.10/$0.20 per 1M), same model — in
// exchange Meta trains on prompts and completions. Override with
// META_TEXT_MODEL=muse-spark-1.3 to use the private Standard tier.
export const META_TEXT_CONTRIBUTOR = "muse-spark-1.3-contributor";
export const META_TEXT_STANDARD = "muse-spark-1.3";
export const META_TEXT_DEFAULT = META_TEXT_CONTRIBUTOR;
export const META_TEXT_FRONTIER = "muse-wonder-1.0";

export function metaTextModel(): string {
  return process.env.META_TEXT_MODEL ?? META_TEXT_DEFAULT;
}
// Unverified: no independent source confirms an image model on the Model API
// as of 2026-10-26. Test with a real key before relying on it.
export const META_IMAGE_MODEL = "muse-image-1.0";

export function getMetaClient(apiKey: string): OpenAI {
  // Pin the SDK to the platform fetch so proxy env (sandbox) and runtime
  // fetch patches are honored. Elsewhere this is identical to default.
  return new OpenAI({
    baseURL: META_BASE_URL,
    apiKey,
    fetch: ((...args: Parameters<typeof fetch>) => fetch(...args)) as never,
  });
}

export async function getMetaStatus(): Promise<unknown> {
  const res = await fetch(`${META_BASE_URL}/status`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`status endpoint returned ${res.status}`);
  return res.json();
}

export async function testMetaText(
  apiKey: string,
  model: string = metaTextModel(),
): Promise<string> {
  const client = getMetaClient(apiKey);
  const resp = await client.responses.create(
    { model, input: "Reply with the single word OK." },
    { timeout: 30000 },
  );
  return resp.output_text.slice(0, 500);
}
