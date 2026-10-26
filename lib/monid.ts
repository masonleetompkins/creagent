// Direct REST client for Monid (https://api.monid.ai).
// Shapes reverse-engineered from @monid-ai/cli 0.1.8 request builders.
export const MONID_BASE_URL = "https://api.monid.ai";

export type MonidRunStatus =
  | "COMPLETED"
  | "FAILED"
  | "STOPPED"
  | "TIMED_OUT"
  | string;

export type MonidRunResult = {
  runId: string;
  status: MonidRunStatus;
  providerResponse?: unknown;
  // Observed live: the actual payload arrives on top-level `output`
  // (providerResponse is just {httpStatus}). Prefer output.
  output?: unknown;
  cost?: unknown;
  usage?: unknown;
  hints?: unknown;
};

async function monidRequest(
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${MONID_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`monid ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<unknown>;
}

export async function monidBalance(apiKey: string): Promise<unknown> {
  return monidRequest(apiKey, "GET", "/v1/wallet/balance");
}

export async function monidDiscover(
  apiKey: string,
  query: string,
  limit = 5,
): Promise<unknown> {
  return monidRequest(apiKey, "POST", "/v1/discover", { query, limit });
}

export async function monidInspect(
  apiKey: string,
  provider: string,
  endpoint: string,
): Promise<unknown> {
  return monidRequest(apiKey, "POST", "/v1/inspect", { provider, endpoint });
}

export async function monidRun(
  apiKey: string,
  provider: string,
  endpoint: string,
  input?: { body?: unknown; queryParams?: unknown; pathParams?: unknown },
): Promise<MonidRunResult> {
  const reqBody: Record<string, unknown> = { provider, endpoint };
  if (input && Object.keys(input).length > 0) reqBody.input = input;
  return (await monidRequest(apiKey, "POST", "/v1/run", reqBody)) as MonidRunResult;
}

export async function monidGetRun(
  apiKey: string,
  runId: string,
): Promise<MonidRunResult> {
  return (await monidRequest(
    apiKey,
    "GET",
    `/v1/runs/${encodeURIComponent(runId)}`,
  )) as MonidRunResult;
}

const TERMINAL = new Set(["COMPLETED", "FAILED", "STOPPED", "TIMED_OUT"]);

export async function monidRunAndWait(
  apiKey: string,
  provider: string,
  endpoint: string,
  input?: { body?: unknown; queryParams?: unknown; pathParams?: unknown },
  options?: { timeoutMs?: number; pollMs?: number },
): Promise<MonidRunResult> {
  const timeoutMs = options?.timeoutMs ?? 300000;
  const pollMs = options?.pollMs ?? 3000;
  const started = await monidRun(apiKey, provider, endpoint, input);
  if (TERMINAL.has(started.status)) return started;
  const deadline = Date.now() + timeoutMs;
  let current = started;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    current = await monidGetRun(apiKey, started.runId);
    if (TERMINAL.has(current.status)) return current;
  }
  throw new Error(`monid run ${started.runId} timed out after ${timeoutMs}ms`);
}
