#!/usr/bin/env -S npx tsx
import { createServer } from "node:http";
import { Readable } from "node:stream";

const PORT = 3000;
const ORIGIN = "http://dummyjson.com";

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

  const upstreamUrl = new URL(req.url, ORIGIN);
  console.log(`${req.method} - ${req.url} - ${upstreamUrl.href}`);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? "half" : undefined,
      // Relay 3xx to the client as-is instead of fetch silently resolving it —
      // also avoids re-sending a consumed streaming body on a followed redirect.
      redirect: "manual",
    });
  } catch (err) {
    console.error("upstream request failed:", err);
    res.writeHead(502);
    res.end("Bad Gateway\n");
    return;
  }

  for (const [name, value] of upstreamRes.headers) {
    const lower = name.toLowerCase();
    if (lower === "set-cookie" || HOP_BY_HOP_HEADERS.has(lower)) {
      continue;
    }
    res.setHeader(name, value);
  }
  // headers.entries()/forEach join multiple Set-Cookie into one invalid comma-joined
  // string; getSetCookie() is the only way to get them back out separately.
  const setCookie = upstreamRes.headers.getSetCookie();
  if (setCookie.length > 0) {
    res.setHeader("set-cookie", setCookie);
  }

  res.writeHead(upstreamRes.status);
  if (upstreamRes.body) {
    Readable.fromWeb(upstreamRes.body).pipe(res);
  } else {
    res.end();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`listening on http://127.0.0.1:${PORT}`);
});
