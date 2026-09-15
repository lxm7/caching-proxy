#!/usr/bin/env -S npx tsx
import { createServer } from "node:http";
import { Readable } from "node:stream";

const PORT = 3000;
const ORIGIN = "http://dummyjson.com";
const ORIGIN_HOST = new URL(ORIGIN).host;
const TTL_MS = 60_000;
const MAX_ENTRIES = 100;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
]);

interface CacheEntry {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(method: string, url: URL): string {
  return `${method}:${url.href}`;
}

const server = createServer(async (req, res) => {
  if (req.url === undefined || !req.url.startsWith("/")) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad Request\n");
    return;
  }

  const method = req.method ?? "GET";
  const upstreamUrl = new URL(req.url, ORIGIN);
  console.log(`${method} - ${req.url} - ${upstreamUrl.href}`);

  // Handled locally, never forwarded: dummyjson.com has no /_cache route, so
  // this is purely an admin endpoint on the proxy itself. Intercepting it
  // here (before any upstream fetch) is what lets a `--clear-cache` CLI flag
  // hit a live process's cache over HTTP instead of needing a restart.
  if (method === "DELETE" && upstreamUrl.pathname === "/_cache") {
    const count = cache.size;
    cache.clear();
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
    const redirectTarget = location ? new URL(location, upstreamUrl) : null;
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
    if (lower === "set-cookie" || HOP_BY_HOP_HEADERS.has(lower)) {
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
      upstreamStream.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      upstreamStream.on("end", () => {
        const key = cacheKey(method, upstreamUrl);
        if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
          const oldestKey = cache.keys().next().value;
          if (oldestKey !== undefined) {
            cache.delete(oldestKey);
            console.log(`EVICTED ${oldestKey}`);
          }
        }
        cache.set(key, {
          status: upstreamRes.status,
          headers: cacheableHeaders,
          body: Buffer.concat(chunks),
          cachedAt: Date.now(),
        });
        console.log(`STORED ${key}`);
      });
    }
    upstreamStream.pipe(res);
  } else {
    res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`listening on http://127.0.0.1:${PORT}`);
});
