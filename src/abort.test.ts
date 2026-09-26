import { test } from "node:test";
import assert from "node:assert/strict";
import { startStubOrigin, startProxy } from "./utils/testHelpers.js";

// Aborting before the upstream response even arrives is the case `pipeline()`
// can't clean up on its own — that only kicks in once a body stream exists.
// This is what the explicit AbortController wired into fetchUpstream covers.
test("drops the pending upstream fetch when the client disconnects before headers arrive (B6)", async (t) => {
  let upstreamAbandoned = false;
  const origin = await startStubOrigin({
    "/hang": (req) => {
      // Never responds — simulates a stuck origin. Only tracks whether the
      // proxy tears down its end of this connection.
      req.socket.on("close", () => {
        upstreamAbandoned = true;
      });
    },
  });
  const proxy = await startProxy(origin.url);
  t.after(() => {
    origin.server.close();
    proxy.server.close();
  });

  const controller = new AbortController();
  const reqPromise = fetch(`${proxy.url}/hang`, { signal: controller.signal });
  // Let the proxy's own fetch reach the stub before disconnecting.
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await assert.rejects(() => reqPromise);

  // Give the abort time to propagate proxy -> upstream.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    upstreamAbandoned,
    true,
    "proxy should drop the pending upstream connection once its own client is gone",
  );
});

test("aborts the upstream fetch when the client disconnects mid-stream (B6)", async (t) => {
  let upstreamAbandoned = false;
  const origin = await startStubOrigin({
    "/slow": (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("chunk-1");
      const interval = setInterval(() => res.write("chunk"), 20);
      res.on("close", () => {
        clearInterval(interval);
        // A 'close' before we ever called end() means our own client (the
        // proxy) hung up on us, not that we finished sending.
        if (!res.writableEnded) upstreamAbandoned = true;
      });
    },
  });
  const proxy = await startProxy(origin.url);
  t.after(() => {
    origin.server.close();
    proxy.server.close();
  });

  const controller = new AbortController();
  const res = await fetch(`${proxy.url}/slow`, { signal: controller.signal });
  const reader = res.body!.getReader();
  await reader.read(); // prove streaming has started before disconnecting
  controller.abort();
  await reader.read().catch(() => {});

  // Give the abort time to propagate proxy -> upstream.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    upstreamAbandoned,
    true,
    "the stub's socket to the proxy should be closed, not left streaming forever",
  );
});
