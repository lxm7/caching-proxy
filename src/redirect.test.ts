import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
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
  return new Promise<{ url: string; server: Server }>((resolve) => {
    server.on("listening", () => {
      resolve({ url: `http://127.0.0.1:${getPort(server)}`, server });
    });
  });
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

// Route table keyed by path, so each test can script exactly the
// redirect/target sequence it needs without a real second host.
function startStubOrigin(routes: Record<string, RouteHandler>) {
  const hitCounts = new Map<string, number>();
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    hitCounts.set(path, (hitCounts.get(path) ?? 0) + 1);
    const handler = routes[path];
    if (!handler) {
      res.writeHead(404);
      res.end();
      return;
    }
    handler(req, res);
  });
  return new Promise<{ url: string; hitCounts: Map<string, number>; server: Server }>(
    (resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve({ url: `http://127.0.0.1:${getPort(server)}`, hitCounts, server });
      });
    },
  );
}

async function setup(t: TestContext, routes: Record<string, RouteHandler>) {
  const origin = await startStubOrigin(routes);
  const proxy = await startProxy(origin.url);
  t.after(() => {
    origin.server.close();
    proxy.server.close();
  });
  return { origin, proxy };
}

test("follows a same-host redirect and returns the final response", async (t) => {
  const { origin, proxy } = await setup(t, {
    "/redirect-same-host": (_req, res) => {
      res.writeHead(302, { location: "/target" });
      res.end();
    },
    "/target": (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  const res = await fetch(`${proxy.url}/redirect-same-host`);
  const body: unknown = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(origin.hitCounts.get("/redirect-same-host"), 1);
  assert.equal(origin.hitCounts.get("/target"), 1);
});

test("caches the resolved redirect response under the original request URL", async (t) => {
  const { origin, proxy } = await setup(t, {
    "/redirect-same-host": (_req, res) => {
      res.writeHead(302, { location: "/target" });
      res.end();
    },
    "/target": (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  await fetch(`${proxy.url}/redirect-same-host`);
  const res = await fetch(`${proxy.url}/redirect-same-host`);

  assert.equal(res.headers.get("x-cache"), "HIT");
  assert.equal(origin.hitCounts.get("/redirect-same-host"), 1, "second call should not re-hit the redirect route");
  assert.equal(origin.hitCounts.get("/target"), 1, "second call should not re-hit the resolved target either");
});

test("relays a cross-host redirect as-is without following it", async (t) => {
  const { origin, proxy } = await setup(t, {
    "/redirect-cross-host": (_req, res) => {
      // Points at a port nothing listens on. If the proxy ever did try to
      // follow this, the fetch would fail (ECONNREFUSED) and surface as a
      // 502, not a relayed 302 — so status 302 here proves it wasn't fetched.
      res.writeHead(302, { location: "http://127.0.0.1:9/evil" });
      res.end();
    },
  });

  const res = await fetch(`${proxy.url}/redirect-cross-host`, { redirect: "manual" });

  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "http://127.0.0.1:9/evil");
  assert.equal(origin.hitCounts.get("/redirect-cross-host"), 1);
});

test("does not follow a redirect for a request with a body", async (t) => {
  const { origin, proxy } = await setup(t, {
    "/redirect-post": (_req, res) => {
      res.writeHead(301, { location: "/target" });
      res.end();
    },
    "/target": (_req, res) => {
      res.writeHead(200);
      res.end("should not be reached");
    },
  });

  const res = await fetch(`${proxy.url}/redirect-post`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "test" }),
  });

  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "/target");
  assert.equal(origin.hitCounts.get("/redirect-post"), 1);
  assert.equal(origin.hitCounts.get("/target"), undefined, "target should not be hit for a body request");
});
