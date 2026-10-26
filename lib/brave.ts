// Brave Search API client. Docs: api-dashboard.search.brave.com/documentation
export const BRAVE_BASE_URL = "https://api.search.brave.com/res/v1";

export async function braveWebSearch(
  apiKey: string,
  query: string,
  count = 5,
): Promise<unknown> {
  const url = `${BRAVE_BASE_URL}/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`brave search: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<unknown>;
}

export async function testBrave(apiKey: string): Promise<string> {
  const data = (await braveWebSearch(apiKey, "test", 1)) as {
    web?: { results?: Array<{ title?: string }> };
  };
  const first = data.web?.results?.[0]?.title ?? "no title";
  return `Connected. First result for "test": ${first}`.slice(0, 300);
}
