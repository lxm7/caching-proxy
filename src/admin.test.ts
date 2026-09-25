import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { getPort, startProxy, startStubOrigin, setup } from "./utils/testHelpers.js";

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

// `new URL("//host/x", origin)` resolves to host, not origin — a scheme-relative
// path would turn the proxy into an open relay to any host (SSRF). `/\` is the
// same attack: WHATWG URL treats `\` as `/` for http(s). Raw socket because
// fetch() would normalise both paths before they reach the proxy.
for (const prefix of ["//", "/\\"]) {
  test(`returns 400 for a "${prefix}host" request-target, without contacting any host`, async (t) => {
    const { origin, proxy } = await setup(t);
    const other = await startStubOrigin();
    t.after(() => other.server.close());
    const otherHost = new URL(other.url).host;

    const raw = await sendRawRequest(
      proxy.port,
      `GET ${prefix}${otherHost}/secret HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
    );

    assert.match(raw, /^HTTP\/1\.1 400 /);
    assert.equal(other.hitCounts.size, 0, "proxy must never fetch a host other than the origin");
    assert.equal(origin.hitCounts.size, 0, "rejected before any upstream call");
  });
}
