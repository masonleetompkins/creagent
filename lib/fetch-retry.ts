// fetch with bounded retries for flaky image hosts and proxies.
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  attempts = 3,
  backoffMs = 1500,
): Promise<Response> {
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
      }
    }
  }
  throw new Error(`fetch failed after ${attempts} tries: ${lastError}`);
}
