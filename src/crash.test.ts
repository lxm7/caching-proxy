import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./utils/testHelpers.js";

test("survives the upstream socket dying mid-body and keeps serving requests", async (t) => {
  const { proxy } = await setup(t, {
    "/flaky": (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      // Destroy only once "partial" is flushed to the socket, so the proxy's
      // fetch() to us already has status/headers before the body dies —
      // otherwise the whole fetch() rejects and never reaches the streaming
      // (pipeline) code path this test is meant to exercise.
      res.write("partial", () => res.destroy());
    },
    "/ok": (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  const flaky = await fetch(`${proxy.url}/flaky`);
  await assert.rejects(
    () => flaky.text(),
    "client should see the cut-short response as an error, not a silent truncation",
  );

  const res = await fetch(`${proxy.url}/ok`);
  const body: unknown = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true }, "proxy should still be serving requests after the crash");
});
