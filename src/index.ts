import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pipeline, Readable } from "node:stream";

export const TTL_MS = 60_000;
export const MAX_ENTRIES = 100;
export const MAX_ENTRY_BYTES = 1_000_000; // 1MB — single response ceiling
export const MAX_BYTES = 5_000_000; // 5MB — total cache budget; MAX_ENTRY_BYTES must stay <= this

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
  cachedAt: number;
}

function cacheKey(method: string, url: URL): string {
  return `${method}:${url.href}`;
}

export function startServer({ port, origin }: { port: number; origin: string }) {
  const ORIGIN_URL = new URL(origin);
  const ORIGIN_HOST = ORIGIN_URL.host;
  const cache = new Map<string, CacheEntry>();
  let totalBytes = 0;

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

    // Handled locally, never forwarded: dummyjson.com has no /_cache route, so
    // this is purely an admin endpoint on the proxy itself. Intercepting it
    // here (before any upstream fetch) is what lets a `--clear-cache` CLI flag
    // hit a live process's cache over HTTP instead of needing a restart.
    if (method === "DELETE" && upstreamUrl.pathname === "/_cache") {
      const count = cache.size;
      cache.clear();
      totalBytes = 0;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`Cleared ${count} entries\n`);
      return;
    }

    if (method === "GET") {
      const key = cacheKey(method, upstreamUrl);
      const cached = cache.get(key);
      if (cached && Date.now() - cached.cachedAt < TTL_MS) {
        // Map preserves insertion order; re-inserting the key on every hit
        // moves it to the end, so oldest-first iteration below is LRU, not FIFO.
        cache.delete(key);
        cache.set(key, cached);
        console.log(`HIT ${key}`);
        for (const [name, value] of Object.entries(cached.headers)) {
          res.setHeader(name, value);
        }
        res.setHeader("X-Cache", "HIT");
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

    const hasBody = method !== "GET" && method !== "HEAD";

    const fetchUpstream = (url: URL) =>
      fetch(url, {
        method,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? "half" : undefined,
        // Never let fetch auto-follow: a redirect Location is upstream-controlled,
        // and following blindly is an SSRF vector (upstream could redirect to an
        // internal address). Each hop is validated against ORIGIN_HOST below
        // before we ever issue a second request.
        redirect: "manual",
      });

    let upstreamRes;
    try {
      upstreamRes = await fetchUpstream(upstreamUrl);
    } catch (err) {
      console.error("upstream request failed:", err);
      res.writeHead(502);
      res.end("Bad Gateway\n");
      return;
    }

    // GET/HEAD have no body to replay, so a same-origin http->https redirect
    // (e.g. dummyjson.com) can be resolved into a cacheable 2xx. Bounded to one
    // hop, and only followed when Location's host matches ORIGIN — anything
    // else (different host/port) stays a relayed 3xx rather than being fetched.
    if (!hasBody && upstreamRes.status >= 300 && upstreamRes.status < 400) {
      const location = upstreamRes.headers.get("location");
      // URL.parse (not the constructor) so a malformed Location — e.g.
      // `http://[bad` — falls through to relaying the 3xx as-is instead of
      // throwing outside any try in this async handler.
      const redirectTarget = location ? URL.parse(location, upstreamUrl) : null;
      if (redirectTarget && redirectTarget.host === ORIGIN_HOST) {
        try {
          upstreamRes = await fetchUpstream(redirectTarget);
        } catch (err) {
          console.error("upstream request failed:", err);
          res.writeHead(502);
          res.end("Bad Gateway\n");
          return;
        }
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

    const cacheable =
      method === "GET" && upstreamRes.status >= 200 && upstreamRes.status < 300;

    if (upstreamRes.body) {
      const upstreamStream = Readable.fromWeb(upstreamRes.body);
      if (cacheable) {
        const chunks: Uint8Array[] = [];
        let bufferedSize = 0;
        let tooLargeToCache = false;
        upstreamStream.on("data", (chunk: Uint8Array) => {
          if (tooLargeToCache) return;
          bufferedSize += chunk.byteLength;
          if (bufferedSize > MAX_ENTRY_BYTES) {
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
          const key = cacheKey(method, upstreamUrl);
          if (tooLargeToCache) {
            console.log(`SKIPPED (too large) ${key}`);
            return;
          }
          const body = Buffer.concat(chunks);
          const existing = cache.get(key);
          if (existing) {
            cache.delete(key);
            totalBytes -= existing.body.byteLength;
          }
          while (cache.size >= MAX_ENTRIES && evictOldest()) {}
          while (totalBytes + body.byteLength > MAX_BYTES && evictOldest()) {}
          cache.set(key, {
            status: upstreamRes.status,
            headers: cacheableHeaders,
            body,
            cachedAt: Date.now(),
          });
          totalBytes += body.byteLength;
          console.log(`STORED ${key}`);
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

  const server = createServer((req, res) => {
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
