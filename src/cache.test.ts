import { test } from "node:test";
import assert from "node:assert/strict";
import { TTL_MS, MAX_ENTRIES } from "./index.js";
import { setup } from "./utils/testHelpers.js";

function hasPath(value: unknown): value is { path: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "path" in value &&
    typeof value.path === "string"
  );
}

test("first request for a URL is a MISS and reaches the origin", async (t) => {
  const { origin, proxy } = await setup(t);

  const res = await fetch(`${proxy.url}/thing`);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-cache"), "MISS");
  assert.equal(origin.hitCounts.get("/thing"), 1);
});

test("repeat request for the same URL is a HIT and does not re-hit the origin", async (t) => {
  const { origin, proxy } = await setup(t);

  await fetch(`${proxy.url}/thing`);
  const res = await fetch(`${proxy.url}/thing`);
  const body: unknown = await res.json();

  assert.equal(res.headers.get("x-cache"), "HIT");
  assert.ok(hasPath(body), "expected response body to include a path field");
  assert.equal(body.path, "/thing");
  assert.equal(origin.hitCounts.get("/thing"), 1, "origin should not be re-fetched on a cache hit");
});

test("entry re-fetches from origin once the TTL has elapsed", async (t) => {
  const { origin, proxy } = await setup(t);

  await fetch(`${proxy.url}/thing`);

  // Advances Date.now() only — no real 60s wait, and doesn't touch the real
  // timers the HTTP stack relies on underneath. Must seed with the real
  // clock: enable() defaults the fake clock to epoch 0, which would make
  // Date.now() go backwards relative to the already-recorded cachedAt.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(TTL_MS + 1);

  const res = await fetch(`${proxy.url}/thing`);

  assert.equal(res.headers.get("x-cache"), "MISS");
  assert.equal(origin.hitCounts.get("/thing"), 2);
});

test("evicts the least-recently-used entry once MAX_ENTRIES is exceeded", async (t) => {
  const { origin, proxy } = await setup(t);

  for (let i = 0; i < MAX_ENTRIES; i++) {
    await fetch(`${proxy.url}/item/${i}`);
  }
  // One more distinct key pushes the cache past MAX_ENTRIES, evicting the
  // oldest entry (/item/0).
  await fetch(`${proxy.url}/item/${MAX_ENTRIES}`);

  const evicted = await fetch(`${proxy.url}/item/0`);
  assert.equal(evicted.headers.get("x-cache"), "MISS", "oldest entry should have been evicted");
  assert.equal(origin.hitCounts.get("/item/0"), 2);

  const survivor = await fetch(`${proxy.url}/item/${MAX_ENTRIES}`);
  assert.equal(survivor.headers.get("x-cache"), "HIT", "most recently inserted entry should still be cached");
  assert.equal(origin.hitCounts.get(`/item/${MAX_ENTRIES}`), 1);
});
