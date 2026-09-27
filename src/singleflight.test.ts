import { test } from "node:test";
import assert from "node:assert/strict";
import { startStubOrigin, startProxy } from "./utils/testHelpers.js";

test("coalesces concurrent requests for the same key into one upstream fetch (17a/17b)", async (t) => {
  const origin = await startStubOrigin({
    "/slow": (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ hello: "world" }));
      }, 100);
    },
  });
  const proxy = await startProxy(origin.url);
  t.after(() => {
    origin.server.close();
    proxy.server.close();
  });

  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      fetch(`${proxy.url}/slow`).then(async (r) => ({
        status: r.status,
        xCache: r.headers.get("x-cache"),
        body: (await r.json()) as { hello: string },
      })),
    ),
  );

  assert.equal(origin.hitCounts.get("/slow"), 1, "20 concurrent requests should reach the origin once");
  for (const r of results) {
    assert.equal(r.status, 200);
    assert.equal(r.body.hello, "world");
  }
  const misses = results.filter((r) => r.xCache === "MISS").length;
  const coalesced = results.filter((r) => r.xCache === "HIT-COALESCED").length;
  assert.equal(misses, 1, "exactly one request should be the coalescing leader");
  assert.equal(coalesced, 19, "the rest should replay the leader's response, labelled HIT-COALESCED (D3)");

  // A later request should hit the now-populated cache — coalescing didn't
  // bypass storing the entry.
  const later = await fetch(`${proxy.url}/slow`);
  assert.equal(later.headers.get("x-cache"), "HIT");
  assert.equal(origin.hitCounts.get("/slow"), 1, "still only one origin hit after the cache is warm");
});

test("keeps serving followers when the coalescing leader's own client disconnects mid-fetch (17c)", async (t) => {
  const origin = await startStubOrigin({
    "/slow": (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ hello: "world" }));
      }, 150);
    },
  });
  const proxy = await startProxy(origin.url);
  t.after(() => {
    origin.server.close();
    proxy.server.close();
  });

  const leaderController = new AbortController();
  const leaderPromise = fetch(`${proxy.url}/slow`, { signal: leaderController.signal }).catch(() => null);

  // Let the leader register itself before the followers attach.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const followerPromises = [
    fetch(`${proxy.url}/slow`).then(async (r) => ({ status: r.status, body: (await r.json()) as { hello: string } })),
    fetch(`${proxy.url}/slow`).then(async (r) => ({ status: r.status, body: (await r.json()) as { hello: string } })),
  ];

  // Disconnect the leader well before the origin responds, while followers
  // are still waiting on its fetch.
  await new Promise((resolve) => setTimeout(resolve, 20));
  leaderController.abort();

  const [, follower1, follower2] = await Promise.all([leaderPromise, ...followerPromises]);

  assert.equal(follower1.status, 200);
  assert.equal(follower1.body.hello, "world");
  assert.equal(follower2.status, 200);
  assert.equal(follower2.body.hello, "world");
  assert.equal(
    origin.hitCounts.get("/slow"),
    1,
    "the leader's client disconnecting must not abort the fetch its followers are waiting on",
  );
});
