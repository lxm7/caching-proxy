#!/usr/bin/env -S npx tsx
import { createServer } from "node:http";

const PORT = 3000;

const server = createServer((_req, res) => {
  res.writeHead(200);
  res.end("OK\n");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`listening on http://127.0.0.1:${PORT}`);
});
