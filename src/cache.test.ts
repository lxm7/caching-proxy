import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { TTL_MS, MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_BYTES } from "./index.js";
import { setup, type RouteHandler } from "./utils/testHelpers.js";

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

test("response larger than MAX_ENTRY_BYTES is served but never cached", async (t) => {
  const bigBody = Buffer.alloc(MAX_ENTRY_BYTES + 1, "x");
  const { origin, proxy } = await setup(t, {
    "/big": (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(bigBody);
    },
  });

  const first = await fetch(`${proxy.url}/big`);
  const firstBody = await first.arrayBuffer();
  assert.equal(first.headers.get("x-cache"), "MISS");
  assert.equal(firstBody.byteLength, bigBody.byteLength, "client should still receive the full body");

  const second = await fetch(`${proxy.url}/big`);
  assert.equal(second.headers.get("x-cache"), "MISS", "oversized response should not have been cached");
  assert.equal(origin.hitCounts.get("/big"), 2, "origin is re-fetched every time for an oversized response");
});

test("total cached bytes are capped, evicting LRU entries to make room", async (t) => {
  // Each entry is under MAX_ENTRY_BYTES (individually cacheable), but enough
  // of them together exceed MAX_BYTES, forcing the byte-budget eviction path
  // rather than the entry-count one.
  const entrySize = 900_000;
  const entryCount = Math.ceil(MAX_BYTES / entrySize) + 1;
  const body = Buffer.alloc(entrySize, "x");
  const routes: Record<string, RouteHandler> = {};
  for (let i = 0; i < entryCount; i++) {
    routes[`/entry-${i}`] = (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(body);
    };
  }
  const { origin, proxy } = await setup(t, routes);

  for (let i = 0; i < entryCount; i++) {
    // fetch() resolves once headers arrive, not once the body (and the
    // proxy's async cache.set() that follows it) is fully drained — read the
    // body so each entry's caching has actually landed before the next request.
    const res = await fetch(`${proxy.url}/entry-${i}`);
    await res.arrayBuffer();
  }

  const evicted = await fetch(`${proxy.url}/entry-0`);
  assert.equal(evicted.headers.get("x-cache"), "MISS", "oldest entry should have been evicted to stay under MAX_BYTES");
  assert.equal(origin.hitCounts.get("/entry-0"), 2);

  const survivor = await fetch(`${proxy.url}/entry-${entryCount - 1}`);
  assert.equal(survivor.headers.get("x-cache"), "HIT", "most recently inserted entry should still be cached");
  assert.equal(origin.hitCounts.get(`/entry-${entryCount - 1}`), 1);
});

test("gzipped origin response is relayed in full on MISS and HIT", async (t) => {
  // Highly compressible, so the gzip content-length is a small fraction of
  // the decoded size: a relayed upstream content-length truncates visibly.
  const decoded = Buffer.from(
    JSON.stringify({ items: Array.from({ length: 100 }, (_, i) => ({ id: i, name: "item" })) }),
  );
  const compressed = gzipSync(decoded);
  const { origin, proxy } = await setup(t, {
    "/gz": (_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": compressed.byteLength,
      });
      res.end(compressed);
    },
  });

  const miss = await fetch(`${proxy.url}/gz`);
  const missBody = Buffer.from(await miss.arrayBuffer());
  assert.equal(miss.headers.get("x-cache"), "MISS");
  assert.equal(missBody.byteLength, decoded.byteLength, "MISS body should be the full decoded payload");
  assert.deepEqual(missBody, decoded);

  const hit = await fetch(`${proxy.url}/gz`);
  const hitBody = Buffer.from(await hit.arrayBuffer());
  assert.equal(hit.headers.get("x-cache"), "HIT");
  assert.equal(hitBody.byteLength, decoded.byteLength, "HIT body should be the full decoded payload");
  assert.deepEqual(hitBody, decoded);
  assert.equal(origin.hitCounts.get("/gz"), 1);
});
