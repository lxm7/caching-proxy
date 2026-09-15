# Cache Proxy — Plan

Source of truth: `docs/requirements.md`. Minimal MVP, demoed live via two terminals
(proxy server in one, `curl` client in the other) — no persistence across restarts needed.

## Stack

- Node v22.23.2 runtime. TypeScript 7.0.2 (native compiler, decoupled from runtime version).
- `@types/node` pinned to `^22.x` to match the runtime (was `^26.5.1` — mismatched major, fix queued as next file).
- Node core only, no CLI/proxy libraries: `node:http` (`createServer` + `request`), `node:util` (`parseArgs`).

## Deliverables

1. **`package.json` fix** — pin `@types/node` to `^22.x`. Add `tsconfig.json` (strict).
2. **CLI entry** — `util.parseArgs` for `--port <number>`, `--origin <url>`, `--clear-cache`.
3. **Cache store** — in-memory `Map`, key = `method + url`, value = `{ status, headers, body: Buffer }`.
   Lives for the life of the server process; resets on restart (fine for a demo).
4. **Proxy handler** — single `http.createServer` listener:
   - Reserved route `DELETE /__cache` clears the `Map`, responds, and returns early (checked before any proxy logic).
   - Otherwise: cache lookup on `method + url`.
     - HIT → replay stored status/headers/body, add `X-Cache: HIT`.
     - MISS → forward via `http.request` to origin, buffer the full response body (`Buffer.concat` over chunks), store in cache, return to client with `X-Cache: MISS`.
5. **`--clear-cache` CLI flag** — thin wrapper: fires `DELETE http://localhost:<port>/__cache` and exits. Satisfies the literal requirements.md contract while the actual clear logic lives in the running server.
6. **Manual verification** — two terminals: terminal A runs `caching-proxy --port 3000 --origin http://dummyjson.com`; terminal B curls `/products` twice (confirm MISS then HIT), curls `DELETE /__cache` (or runs `caching-proxy --clear-cache`), curls `/products` again (confirm back to MISS).

## Body handling

Buffer full request/response bodies for MVP (`Buffer.concat` over chunks). Streaming
(pipe origin response straight through without buffering, cache concurrently) is a
deliberate post-MVP step — buffering first is simpler to get right (status/headers/full
body all available before deciding what to cache) and tells us whether streaming is
even needed for the demo.

## Decisions (confirmed)

- `@types/node` → `^22.x` (mismatch fix).
- Cache store → in-memory `Map`, not disk-backed — valid because clear-cache is a route
  on the same process, not a separate CLI invocation reaching into someone else's memory.
- CLI parsing → `node:util` `parseArgs`.
- Origin forwarding → `node:http`/`node:https` `request`, not `fetch` — symmetric with
  `createServer`, and `res.pipe()` is the natural path when streaming is added later.
- Cache-clear mechanism → reserved `DELETE /__cache` route on the running server; CLI
  flag wraps it as an HTTP call rather than touching shared memory directly.

## Open question

Route path `/__cache` could theoretically collide with a real origin path. Acceptable
for MVP — flag if the demo origin (`dummyjson.com`) ever needs that exact path.

## Status

Not started. Next file: `package.json` (pin `@types/node`).
