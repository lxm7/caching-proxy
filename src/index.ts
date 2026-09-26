import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { performance } from "node:perf_hooks";
import { pipeline, Readable } from "node:stream";

export const TTL_MS = 60_000;
export const MAX_ENTRIES = 100;
export const MAX_ENTRY_BYTES = 1_000_000; // 1MB — single response ceiling
export const MAX_BYTES = 5_000_000; // 5MB — total cache budget; MAX_ENTRY_BYTES must stay <= this
export const UPSTREAM_TIMEOUT_MS = 10_000; // default; step 8a wires this into AbortSignal.timeout

export interface ProxyConfig {
  ttlMs: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxBytes: number;
  timeoutMs: number;
}

export const DEFAULT_CONFIG: ProxyConfig = {
  ttlMs: TTL_MS,
  maxEntries: MAX_ENTRIES,
  maxEntryBytes: MAX_ENTRY_BYTES,
  maxBytes: MAX_BYTES,
  timeoutMs: UPSTREAM_TIMEOUT_MS,
};

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Not hop-by-hop: stripped because fetch decodes the body, so both headers
// describe the wire bytes, not what we relay. Dropping content-length alone
// is what prevents Node truncating the body at the compressed length.
const DECODED_BODY_HEADERS = new Set(["content-encoding", "content-length"]);

interface CacheEntry {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  storedAt: number; // performance.now() — monotonic, immune to wall-clock jumps
  ttlMs: number;
}

function cacheKey(method: string, url: URL): string {
  return `${method}:${url.href}`;
}

// Directive values are the literal token/quoted-string after "=", or `true`
// for a valueless directive like `no-store` or `public`.
function parseCacheControl(header: string | null): Map<string, string | true> {
  const directives = new Map<string, string | true>();
  if (!header) return directives;
  for (const part of header.split(",")) {
    const [rawName, rawValue] = part.split("=", 2);
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    directives.set(name, rawValue === undefined ? true : rawValue.trim().replace(/^"|"$/g, ""));
  }
  return directives;
}

// accept-encoding is excluded: this proxy always fully decodes the body and
// strips content-encoding/content-length before storing (DECODED_BODY_HEADERS),
// and never forwards the client's accept-encoding upstream (undici negotiates
// its own). So every stored entry is already identical regardless of what the
// client asked for — varying the key on it would only fragment the cache.
const IGNORED_VARY_HEADERS = new Set(["accept-encoding"]);

function parseVaryNames(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name && !IGNORED_VARY_HEADERS.has(name));
}

function varySuffix(varyNames: string[], headers: IncomingHttpHeaders): string {
  return varyNames.map((name) => `${name}=${headers[name] ?? ""}`).join("&");
}

// s-maxage > max-age > Expires > the configured default. Expires needs one
// wall-clock read (it's an absolute date); freshness checks after storage
// compare against performance.now() instead, so a later clock jump can't
// expire or revive every entry at once.
function resolveTtlMs(
  cacheControl: Map<string, string | true>,
  expiresHeader: string | null,
  fallbackMs: number,
): number {
  const sMaxAge = Number(cacheControl.get("s-maxage"));
  if (Number.isFinite(sMaxAge) && sMaxAge >= 0) return sMaxAge * 1000;
  const maxAge = Number(cacheControl.get("max-age"));
  if (Number.isFinite(maxAge) && maxAge >= 0) return maxAge * 1000;
  if (expiresHeader) {
    const expiresInMs = Date.parse(expiresHeader) - Date.now();
    if (Number.isFinite(expiresInMs)) return Math.max(expiresInMs, 0);
  }
  return fallbackMs;
}

// Allowlist, not a blocklist (D1): a header the cache key ignores could
// otherwise change the origin's response and poison the shared cache for
// everyone. Never host/content-length/accept-encoding — undici sets and
// negotiates those itself.
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "authorization",
  "content-type",
  "cookie",
  "if-none-match",
  "if-modified-since",
  "range",
  "user-agent",
] as const;

function buildUpstreamHeaders(reqHeaders: IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = reqHeaders[name];
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

// Explicit rather than left at Node's defaults (60s/300s/5s), so the limits
// are visible in code and a slow client trickling headers (Slowloris) can't
// hold a connection open indefinitely.
export const HEADERS_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const KEEP_ALIVE_TIMEOUT_MS = 5_000;

// AbortSignal.timeout() aborts with a DOMException named "TimeoutError";
// fetch() surfaces that as the rejection reason.
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError";
}

// Shared by the initial fetch and the one-hop redirect follow: on failure,
// logs, relays 504 for a timeout or 502 for anything else, and returns null
// so the caller knows to stop (response is already sent at that point).
async function fetchOrRelayError(
  fetchFn: () => Promise<Response>,
  res: ServerResponse,
): Promise<Response | null> {
  try {
    return await fetchFn();
  } catch (err) {
    console.error("upstream request failed:", err);
    if (isTimeoutError(err)) {
      res.writeHead(504);
      res.end("Gateway Timeout\n");
    } else {
      res.writeHead(502);
      res.end("Bad Gateway\n");
    }
    return null;
  }
}

export function startServer({
  port,
  origin,
  config = DEFAULT_CONFIG,
}: {
  port: number;
  origin: string;
  config?: ProxyConfig;
}) {
  const ORIGIN_URL = new URL(origin);
  const ORIGIN_HOST = ORIGIN_URL.host;
  const cache = new Map<string, CacheEntry>();
  // Base key ("method:href") -> the header names an earlier response for that
  // URL declared as its Vary axis. Populated on store (15a); consulted on
  // lookup (15b) to build the key that actually matches this request's variant.
  const varyByUrl = new Map<string, string[]>();
  let totalBytes = 0;
  // Bumped on every /_cache clear. A store captures this before fetching and
  // checks it again in the 'end' handler, so a clear mid-fetch can't have its
  // own response reappear in the cache right after the client asked for it
  // to be gone (B10).
  let generation = 0;

  // Evicts the oldest (LRU) entry; returns false once the cache is empty.
  function evictOldest(): boolean {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) return false;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    if (oldest) totalBytes -= oldest.body.byteLength;
    console.log(`EVICTED ${oldestKey}`);
    return true;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // `//host/x` and `/\host/x` both start with "/" yet resolve to another host,
    // so the origin check is what keeps the proxy from fetching arbitrary hosts.
    // URL.parse (not the constructor) because e.g. `//[bad` would throw here.
    const upstreamUrl = req.url?.startsWith("/") ? URL.parse(req.url, origin) : null;
    if (upstreamUrl === null || upstreamUrl.origin !== ORIGIN_URL.origin) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request\n");
      return;
    }

    const method = req.method ?? "GET";
    console.log(`${method} - ${req.url} - ${upstreamUrl.href}`);

    // Credentialed requests always MISS: the cache is one shared Map across all
    // clients, so serving or storing a response fetched with one caller's
    // authorization/cookie would leak it to the next caller (B11-adjacent auth
    // bypass). Not keyed on a credential hash (RFC 9111 §3.5) — one mistake
    // there is a cross-user leak, and this whole plan trades a bit of origin
    // load for that safety margin.
    const hasCredentials = Boolean(req.headers.authorization || req.headers.cookie);

    // Handled locally, never forwarded: dummyjson.com has no /_cache route, so
    // this is purely an admin endpoint on the proxy itself. Intercepting it
    // here (before any upstream fetch) is what lets a `--clear-cache` CLI flag
    // hit a live process's cache over HTTP instead of needing a restart.
    if (method === "DELETE" && upstreamUrl.pathname === "/_cache") {
      const count = cache.size;
      cache.clear();
      totalBytes = 0;
      generation++;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`Cleared ${count} entries\n`);
      return;
    }

    // 16b: request-side no-cache/no-store skips the read, same as a
    // credentialed request — the fetch below still runs and may refresh
    // whatever's stored.
    const requestCacheControl = parseCacheControl(req.headers["cache-control"] ?? null);
    const bypassCacheRead = requestCacheControl.has("no-cache") || requestCacheControl.has("no-store");

    if (method === "GET" && !hasCredentials && !bypassCacheRead) {
      // 15b: the base key finds this URL's known variant axis, if any
      // response for it ever declared one; that axis's header values then
      // pick out which stored variant actually matches this request.
      const baseKey = cacheKey(method, upstreamUrl);
      const varyNames = varyByUrl.get(baseKey) ?? [];
      const key = varyNames.length > 0 ? `${baseKey}|${varySuffix(varyNames, req.headers)}` : baseKey;
      const cached = cache.get(key);
      if (cached && performance.now() - cached.storedAt < cached.ttlMs) {
        // Map preserves insertion order; re-inserting the key on every hit
        // moves it to the end, so oldest-first iteration below is LRU, not FIFO.
        cache.delete(key);
        cache.set(key, cached);
        console.log(`HIT ${key}`);
        for (const [name, value] of Object.entries(cached.headers)) {
          res.setHeader(name, value);
        }
        res.setHeader("X-Cache", "HIT");
        res.setHeader("Age", String(Math.floor((performance.now() - cached.storedAt) / 1000)));
        res.writeHead(cached.status);
        res.end(cached.body);
        return;
      }
      if (cached) {
        cache.delete(key);
        totalBytes -= cached.body.byteLength;
        console.log(`EXPIRED ${key}`);
      }
    }

    const isBodylessMethod = method === "GET" || method === "HEAD";
    // B4/14b: DELETE and OPTIONS used to always get a streamed body attached
    // even with nothing to send, which some origins reject. A body is only
    // declared, per RFC 9110, via content-length or transfer-encoding.
    const hasDeclaredBody =
      !isBodylessMethod &&
      (Number(req.headers["content-length"]) > 0 || req.headers["transfer-encoding"] !== undefined);
    const requestGeneration = generation;

    // If the client goes away — before headers, or mid-stream — before we're
    // done, stop holding the upstream socket open for a response nobody will
    // read. `writableEnded` is only true once *we* called `res.end()`, so a
    // 'close' after that is a normal completion, not an abandonment.
    const clientAbort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) clientAbort.abort();
    });

    const fetchUpstream = (url: URL) =>
      fetch(url, {
        method,
        headers: buildUpstreamHeaders(req.headers),
        body: hasDeclaredBody ? Readable.toWeb(req) : undefined,
        duplex: hasDeclaredBody ? "half" : undefined,
        // Never let fetch auto-follow: a redirect Location is upstream-controlled,
        // and following blindly is an SSRF vector (upstream could redirect to an
        // internal address). Each hop is validated against ORIGIN_HOST below
        // before we ever issue a second request.
        redirect: "manual",
        // Timeout is fresh per call (not shared across the redirect hop below),
        // so each upstream request gets its own full budget rather than
        // splitting one clock across both. clientAbort is shared across both.
        signal: AbortSignal.any([AbortSignal.timeout(config.timeoutMs), clientAbort.signal]),
      });

    let upstreamRes = await fetchOrRelayError(() => fetchUpstream(upstreamUrl), res);
    if (!upstreamRes) return;

    // GET/HEAD have no body to replay, so a same-origin http->https redirect
    // (e.g. dummyjson.com) can be resolved into a cacheable 2xx. Bounded to one
    // hop, and only followed when Location's host matches ORIGIN — anything
    // else (different host/port) stays a relayed 3xx rather than being fetched.
    if (isBodylessMethod && upstreamRes.status >= 300 && upstreamRes.status < 400) {
      const location = upstreamRes.headers.get("location");
      // URL.parse (not the constructor) so a malformed Location — e.g.
      // `http://[bad` — falls through to relaying the 3xx as-is instead of
      // throwing outside any try in this async handler.
      const redirectTarget = location ? URL.parse(location, upstreamUrl) : null;
      if (redirectTarget && redirectTarget.host === ORIGIN_HOST) {
        upstreamRes = await fetchOrRelayError(() => fetchUpstream(redirectTarget), res);
        if (!upstreamRes) return;
      }
    }

    // Mirrors the relayed headers, minus set-cookie: the cache is one shared Map across
    // all clients, so replaying one client's cookies to another on a cache hit would leak
    // sessions. set-cookie still passes through untouched on this (cache-miss) response.
    const cacheableHeaders: Record<string, string> = {};
    for (const [name, value] of upstreamRes.headers) {
      const lower = name.toLowerCase();
      if (
        lower === "set-cookie" ||
        HOP_BY_HOP_HEADERS.has(lower) ||
        DECODED_BODY_HEADERS.has(lower)
      ) {
        continue;
      }
      res.setHeader(name, value);
      cacheableHeaders[name] = value;
    }
    // headers.entries()/forEach join multiple Set-Cookie into one invalid comma-joined
    // string; getSetCookie() is the only way to get them back out separately.
    const setCookie = upstreamRes.headers.getSetCookie();
    if (setCookie.length > 0) {
      res.setHeader("set-cookie", setCookie);
    }
    res.setHeader("X-Cache", "MISS");

    res.writeHead(upstreamRes.status);

    // B11/13a: 206 is deliberately excluded (not just >=200/<300) — a partial
    // body must never be stored under the same key as the full resource. The
    // incoming `range` check is defence in depth for the same reason, in case
    // an origin ever answers a Range request with 200 instead of 206.
    const cacheControl = parseCacheControl(upstreamRes.headers.get("cache-control"));
    const cacheable =
      method === "GET" &&
      !req.headers.range &&
      upstreamRes.status === 200 &&
      !cacheControl.has("no-store") &&
      !cacheControl.has("private") &&
      upstreamRes.headers.get("vary") !== "*" &&
      (!hasCredentials || cacheControl.get("public") === true);

    // 15a/15b: record this URL's variant axis (if any) so later requests can
    // build the matching key, and use it now to build the key this response
    // itself stores under.
    const baseKey = cacheKey(method, upstreamUrl);
    const varyNames = parseVaryNames(upstreamRes.headers.get("vary"));
    if (cacheable && varyNames.length > 0) varyByUrl.set(baseKey, varyNames);
    const storeKey = varyNames.length > 0 ? `${baseKey}|${varySuffix(varyNames, req.headers)}` : baseKey;
    const ttlMs = resolveTtlMs(cacheControl, upstreamRes.headers.get("expires"), config.ttlMs);

    if (upstreamRes.body) {
      const upstreamStream = Readable.fromWeb(upstreamRes.body);
      if (cacheable) {
        const chunks: Uint8Array[] = [];
        let bufferedSize = 0;
        let tooLargeToCache = false;
        upstreamStream.on("data", (chunk: Uint8Array) => {
          if (tooLargeToCache) return;
          bufferedSize += chunk.byteLength;
          if (bufferedSize > config.maxEntryBytes) {
            // Over the single-entry ceiling: stop buffering and drop what's
            // held so far. Client is unaffected — pipe() below is a separate
            // listener on the same stream.
            tooLargeToCache = true;
            chunks.length = 0;
          } else {
            chunks.push(chunk);
          }
        });
        upstreamStream.on("end", () => {
          if (generation !== requestGeneration) {
            console.log(`SKIPPED (cleared mid-fetch) ${storeKey}`);
            return;
          }
          if (tooLargeToCache) {
            console.log(`SKIPPED (too large) ${storeKey}`);
            return;
          }
          const body = Buffer.concat(chunks);
          const existing = cache.get(storeKey);
          if (existing) {
            cache.delete(storeKey);
            totalBytes -= existing.body.byteLength;
          }
          while (cache.size >= config.maxEntries && evictOldest()) {}
          while (totalBytes + body.byteLength > config.maxBytes && evictOldest()) {}
          cache.set(storeKey, {
            status: upstreamRes.status,
            headers: cacheableHeaders,
            body,
            storedAt: performance.now(),
            ttlMs,
          });
          totalBytes += body.byteLength;
          console.log(`STORED ${storeKey}`);
        });
      }
      pipeline(upstreamStream, res, (err) => {
        if (err) {
          console.error("upstream stream error:", err);
          res.destroy(err);
        }
      });
    } else {
      res.end();
    }
  }

  const server = createServer({
    headersTimeout: HEADERS_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
  }, (req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      // Last-resort net: anything that threw or rejected without being
      // caught inside handleRequest lands here instead of crashing the
      // process (an unhandled rejection from an async listener otherwise
      // takes the whole proxy down for every client, not just this request).
      console.error(`unhandled error handling ${req.method ?? "?"} ${req.url ?? "?"}:`, err);
      if (res.headersSent) {
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      } else {
        res.writeHead(502);
        res.end("Bad Gateway\n");
      }
    });
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`listening on http://127.0.0.1:${port}`);
  });

  return server;
}
