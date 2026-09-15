#!/usr/bin/env -S npx tsx
import { createServer, request as httpRequest } from "node:http";

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

const server = createServer((req, res) => {
  if (req.url === undefined || !req.url.startsWith("/")) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad Request\n");
    return;
  }

  const upstreamUrl = new URL(req.url, ORIGIN);
  console.log(`${req.method} - ${req.url} - ${upstreamUrl.href}`);

  const proxyReq = httpRequest(
    upstreamUrl,
    { method: req.method },
    (upstreamRes) => {
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
          continue;
        }
        res.setHeader(name, value);
      }
      res.writeHead(upstreamRes.statusCode ?? 502);
      upstreamRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    console.error("upstream request failed:", err);
    res.writeHead(502);
    res.end("Bad Gateway\n");
  });

  req.pipe(proxyReq);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`listening on http://127.0.0.1:${PORT}`);
});
