// Zernio unified social API client. Docs: docs.zernio.com
export const ZERNIO_BASE_URL = "https://zernio.com/api/v1";

async function zernioRequest(
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${ZERNIO_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`zernio ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<unknown>;
}

export async function zernioProfiles(apiKey: string): Promise<unknown> {
  return zernioRequest(apiKey, "GET", "/v1/profiles");
}

// Hourly-synced analytics changes across every connected account. Cursor
// param name is undocumented; try `cursor`, fall back to no cursor.
export async function zernioAnalyticsDelta(
  apiKey: string,
  cursor: string | null,
): Promise<unknown> {
  const path = cursor
    ? `/v1/analytics/delta?cursor=${encodeURIComponent(cursor)}`
    : "/v1/analytics/delta";
  try {
    return await zernioRequest(apiKey, "GET", path);
  } catch (error) {
    if (cursor && /400|422/.test((error as Error).message)) {
      return zernioRequest(apiKey, "GET", "/v1/analytics/delta");
    }
    throw error;
  }
}

export async function zernioPosts(apiKey: string): Promise<unknown> {
  return zernioRequest(apiKey, "GET", "/v1/posts");
}

export async function testZernio(apiKey: string): Promise<string> {
  const data = (await zernioProfiles(apiKey)) as
    | Array<unknown>
    | { data?: Array<unknown> };
  const list = Array.isArray(data) ? data : (data.data ?? []);
  return `Connected. ${list.length} profile(s) on the account.`;
}
