import type { TestContext } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { startServer } from "../index.js";

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

export function getPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to be listening on a network port");
  }
  return address.port;
}

// Stub origin: counts hits per path so tests can prove whether the proxy
// actually re-fetched or served from cache, without depending on a real API.
// With no `routes`, every path gets the same echo-the-path handler; pass
// `routes` to script an exact redirect/target sequence per path instead.
export function startStubOrigin(routes?: Record<string, RouteHandler>) {
  const hitCounts = new Map<string, number>();
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    hitCounts.set(path, (hitCounts.get(path) ?? 0) + 1);
    const handler = routes?.[path];
    if (routes) {
      if (!handler) {
        res.writeHead(404);
        res.end();
        return;
      }
      handler(req, res);
      return;
    }
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

export function startProxy(origin: string) {
  const server = startServer({ port: 0, origin });
  return new Promise<{ url: string; port: number; server: Server }>((resolve) => {
    server.on("listening", () => {
      const port = getPort(server);
      resolve({ url: `http://127.0.0.1:${port}`, port, server });
    });
  });
}

// Port 0 on both servers + fresh instances per test keeps tests parallel-safe
// and gives each test a clean cache, instead of sharing state across tests.
export async function setup(t: TestContext, routes?: Record<string, RouteHandler>) {
  const origin = await startStubOrigin(routes);
  const proxy = await startProxy(origin.url);
  t.after(() => {
    origin.server.close();
    proxy.server.close();
  });
  return { origin, proxy };
}
