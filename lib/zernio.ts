// Zernio unified social API client. Docs: docs.zernio.com
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { fetchWithRetry } from "./fetch-retry";

export const ZERNIO_BASE_URL = "https://zernio.com/api";

async function zernioRequest(
  apiKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const res = await fetchWithRetry(`${ZERNIO_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
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

// Post performance analytics across every connected account. Requires the
// analytics add-on (hasAnalyticsAccess); returns a paginated list with
// overview stats. Date range caps at 366 days per request.
export type ZernioAnalyticsPage = {
  posts: Array<Record<string, unknown>>;
  total: number;
  pages: number;
  hasAnalyticsAccess: boolean;
};

export async function zernioAnalyticsPage(
  apiKey: string,
  opts: { fromDate?: string; toDate?: string; limit?: number; page?: number },
): Promise<ZernioAnalyticsPage> {
  const params = new URLSearchParams();
  if (opts.fromDate) params.set("fromDate", opts.fromDate);
  if (opts.toDate) params.set("toDate", opts.toDate);
  params.set("limit", String(opts.limit ?? 50));
  params.set("page", String(opts.page ?? 1));
  const data = (await zernioRequest(apiKey, "GET", `/v1/analytics?${params}`)) as Record<
    string,
    unknown
  >;
  const posts = Array.isArray(data["posts"])
    ? (data["posts"] as Array<unknown>).filter(isObj)
    : [];
  const pagination = (data["pagination"] ?? {}) as Record<string, unknown>;
  return {
    posts,
    total: typeof pagination["total"] === "number" ? pagination["total"] : posts.length,
    pages: typeof pagination["pages"] === "number" ? pagination["pages"] : 1,
    hasAnalyticsAccess: data["hasAnalyticsAccess"] === true,
  };
}

export type ZernioAccount = { id: string; platform: string; username: string };

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function zernioAccounts(apiKey: string): Promise<ZernioAccount[]> {
  const data = (await zernioRequest(apiKey, "GET", "/v1/accounts?limit=100")) as Record<
    string,
    unknown
  >;
  const raw = data["accounts"] ?? data["data"];
  const list = Array.isArray(raw) ? raw : [];
  return list.filter(isObj).map((a) => ({
    id: str(a._id ?? a.id),
    platform: str(a.platform ?? a.network ?? "unknown").toLowerCase() || "unknown",
    username: str(a.username ?? a.handle ?? a.name ?? a.displayName) || "(unnamed)",
  })).filter((a) => a.id);
}

export async function zernioAccountPosts(
  apiKey: string,
  accountId: string,
): Promise<Array<Record<string, unknown>>> {
  const data = (await zernioRequest(
    apiKey,
    "GET",
    `/v1/accounts/${encodeURIComponent(accountId)}/posts`,
  )) as Record<string, unknown>;
  const raw = data["posts"] ?? data["data"];
  const list = Array.isArray(raw) ? raw : [];
  return list.filter(isObj);
}

// Publish (or schedule) one post across accounts. Retries MUST reuse the
// same idempotency key — Zernio returns the original post instead of
// double-posting. Docs: docs.zernio.com/posts/create-post
export async function zernioCreatePost(
  apiKey: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<unknown> {
  return zernioRequest(apiKey, "POST", "/v1/posts", body, {
    "Idempotency-Key": idempotencyKey,
    "x-request-id": idempotencyKey,
  });
}

// Post status by id — same { post } shape as create. Poll scheduled posts
// with this; the per-entry platforms[] carry status + platformPostUrl.
export async function zernioGetPost(apiKey: string, postId: string): Promise<unknown> {
  return zernioRequest(apiKey, "GET", `/v1/posts/${encodeURIComponent(postId)}`);
}

// Cancel a scheduled (or failed/draft) post. Published posts 400 here —
// those need unpublish, which this app never calls (posted is posted).
export async function zernioDeletePost(apiKey: string, postId: string): Promise<unknown> {
  return zernioRequest(apiKey, "DELETE", `/v1/posts/${encodeURIComponent(postId)}`);
}

// Local file -> postable URL: presign, PUT the bytes (no auth on the
// presigned URL), return the public URL for mediaItems. Uploads sit in
// temp storage 7 days and go permanent once a post uses them.
export async function zernioPresignMedia(
  apiKey: string,
  file: { filename: string; contentType: string; size: number },
): Promise<{ uploadUrl: string; publicUrl: string }> {
  const res = (await zernioRequest(apiKey, "POST", "/v1/media/presign", {
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
  })) as Record<string, unknown>;
  const uploadUrl = typeof res["uploadUrl"] === "string" ? res["uploadUrl"] : "";
  const publicUrl = typeof res["publicUrl"] === "string" ? res["publicUrl"] : "";
  if (!uploadUrl || !publicUrl) throw new Error("presign returned no upload URL");
  return { uploadUrl, publicUrl };
}

export async function zernioUploadMedia(
  apiKey: string,
  path: string,
  contentType: string,
): Promise<string> {
  const size = statSync(path).size;
  if (size === 0) throw new Error("media file is empty");
  const { uploadUrl, publicUrl } = await zernioPresignMedia(apiKey, {
    filename: basename(path),
    contentType,
    size,
  });
  const put = await fetchWithRetry(
    uploadUrl,
    { method: "PUT", headers: { "Content-Type": contentType }, body: readFileSync(path) as unknown as BodyInit },
    2,
    2000,
  );
  if (!put.ok) throw new Error(`media upload failed: HTTP ${put.status}`);
  return publicUrl;
}

export async function testZernio(apiKey: string): Promise<string> {
  const data = (await zernioProfiles(apiKey)) as
    | Array<unknown>
    | { data?: Array<unknown> };
  const list = Array.isArray(data) ? data : (data.data ?? []);
  return `Connected. ${list.length} profile(s) on the account.`;
}
