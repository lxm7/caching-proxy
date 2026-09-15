#!/usr/bin/env -S npx tsx
import { createServer } from "node:http";

const PORT = 3000;
const ORIGIN = "http://dummyjson.com";

const server = createServer((req, res) => {
  const upstreamUrl = new URL(req.url ?? "/", ORIGIN);
  console.log(`${req.method} - ${req.url} - ${upstreamUrl.href}`);
  res.writeHead(200);
  res.end("OK\n");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`listening on http://127.0.0.1:${PORT}`);
});
