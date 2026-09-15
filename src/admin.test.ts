import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { startServer } from "./index.js";

function getPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to be listening on a network port");
  }
  return address.port;
}

function startProxy(origin: string) {
  const server = startServer({ port: 0, origin });
  return new Promise<{ url: string; port: number; server: Server }>((resolve) => {
    server.on("listening", () => {
      const port = getPort(server);
      resolve({ url: `http://127.0.0.1:${port}`, port, server });
    });
  });
}

function startStubOrigin() {
  const hitCounts = new Map<string, number>();
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    hitCounts.set(path, (hitCounts.get(path) ?? 0) + 1);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path }));
  });
  return new Promise<{ url: string; hitCounts: Map<string, number>; server: Server }>(
    (resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve({ url: `http://127.0.0.1:${getPort(server)}`, hitCounts, server });
      });
    },
  );
}

// Returns a loopback origin URL guaranteed to be unreachable: bind a server
// to an OS-assigned port, then close it immediately. Nothing else grabs an
// ephemeral port in that window in a single-process test run.
function unreachableOrigin() {
  const server = createServer();
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = getPort(server);
      server.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
}

// fetch() can't produce an absolute-form request-target (`GET http://... HTTP/1.1`),
// which is how an explicit-proxy client (e.g. curl -x) addresses a proxy — so this
// writes the request line over a raw socket instead.
function sendRawRequest(port: number, rawRequest: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(rawRequest);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

async function setup(t: TestContext) {
  const origin = await startStubOrigin();
  const proxy = await startProxy(origin.url);
  t.after(() => {
    origin.server.close();
    proxy.server.close();
  });
  return { origin, proxy };
}

test("DELETE /_cache clears the cache and reports how many entries were removed", async (t) => {
  const { proxy } = await setup(t);

  await fetch(`${proxy.url}/one`);
  await fetch(`${proxy.url}/two`);

  const clearRes = await fetch(`${proxy.url}/_cache`, { method: "DELETE" });
  const clearBody = await clearRes.text();

  assert.equal(clearRes.status, 200);
  assert.equal(clearBody.trim(), "Cleared 2 entries");

  const afterClear = await fetch(`${proxy.url}/one`);
  assert.equal(afterClear.headers.get("x-cache"), "MISS", "cache should be empty after clearing");
});

test("DELETE /_cache is handled locally even when the origin is unreachable", async (t) => {
  const origin = await unreachableOrigin();
  const proxy = await startProxy(origin);
  t.after(() => proxy.server.close());

  const res = await fetch(`${proxy.url}/_cache`, { method: "DELETE" });
  const body = await res.text();

  assert.equal(res.status, 200);
  assert.equal(body.trim(), "Cleared 0 entries");
});

test("returns 502 when the origin is unreachable", async (t) => {
  const origin = await unreachableOrigin();
  const proxy = await startProxy(origin);
  t.after(() => proxy.server.close());

  const res = await fetch(`${proxy.url}/anything`);

  assert.equal(res.status, 502);
});

test("returns 400 for an absolute-form request-target, without contacting the origin", async (t) => {
  const { origin, proxy } = await setup(t);

  const raw = await sendRawRequest(
    proxy.port,
    "GET http://example.com/anything HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n",
  );

  assert.match(raw, /^HTTP\/1\.1 400 /);
  assert.match(raw, /Bad Request/);
  assert.equal(origin.hitCounts.size, 0, "malformed request-target should be rejected before any upstream call");
});
