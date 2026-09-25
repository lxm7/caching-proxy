import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  HEADERS_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
} from "./index.js";
import { startStubOrigin, startProxy } from "./utils/testHelpers.js";

test("returns 504 when the upstream exceeds the configured timeout (B7)", async (t) => {
  const origin = await startStubOrigin({
    "/slow": (_req, res) => {
      setTimeout(() => res.end("too slow"), 100);
    },
  });
  const proxy = await startProxy(origin.url, { ...DEFAULT_CONFIG, timeoutMs: 20 });
  t.after(() => {
    origin.server.close();
    proxy.server.close();
  });

  const res = await fetch(`${proxy.url}/slow`);
  assert.equal(res.status, 504);

  // Proxy itself must survive the timeout and keep serving other requests.
  const after = await fetch(`${proxy.url}/slow`);
  assert.equal(after.status, 504);
});

test("server timeouts are set explicitly, not left at Node defaults (B7)", async (t) => {
  const origin = await startStubOrigin();
  const proxy = await startProxy(origin.url);
  t.after(() => {
    origin.server.close();
    proxy.server.close();
  });

  assert.equal(proxy.server.headersTimeout, HEADERS_TIMEOUT_MS);
  assert.equal(proxy.server.requestTimeout, REQUEST_TIMEOUT_MS);
  assert.equal(proxy.server.keepAliveTimeout, KEEP_ALIVE_TIMEOUT_MS);
});
