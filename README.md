# cache-proxy cli demo

A caching HTTP reverse proxy CLI. Point it at any origin server and it forwards
requests to that origin, caches successful `GET` responses in memory, and
serves repeat requests from the cache — no restart or external cache store
required.

## Features

- Transparent reverse proxy for any HTTP(S) origin
- In-memory caching of `GET` responses (2xx only)
- `X-Cache: HIT` / `X-Cache: MISS` response header on every request
- TTL-based expiry (60s) and LRU eviction (100 entries max)
- Cache clearing via CLI flag or HTTP endpoint, without restarting the server
- Safe redirect handling (single bounded same-origin hop, no auto-follow to
  arbitrary hosts)
- Hop-by-hop headers and `Set-Cookie` handled correctly (not replayed across
  clients on cache hits)

## Tools / stack

- [Node.js](https://nodejs.org/) (`node:http`, `node:stream`, `node:util`)
- [TypeScript](https://www.typescriptlang.org/)
- [tsx](https://github.com/privatenumber/tsx) for running TypeScript directly in dev
- Node's built-in test runner (`node:test`) for tests
- No external runtime dependencies

## Requirements

- Node.js (see `@types/node` in `package.json` for the targeted version range)
- pnpm

## Install

```sh
pnpm install
```

## Project commands

Run the proxy directly from TypeScript source (dev):

```sh
npx tsx src/cli.ts --port 3000 --origin http://dummyjson.com
```

Build to plain JS (what actually ships):

```sh
pnpm build
```

Run the built CLI:

```sh
node dist/cli.js --port 3000 --origin http://dummyjson.com
```

Clear the cache of a running instance:

```sh
node dist/cli.js --clear-cache
# or, in dev:
npx tsx src/cli.ts --clear-cache
```

`--clear-cache` defaults to port `3000`; pass `--port <number>` to target a
different running instance.

Run tests:

```sh
pnpm test
```

## CLI usage

```
caching-proxy --port <number> --origin <url>
caching-proxy --clear-cache [--port <number>]
```

| Flag            | Description                                      |
| --------------- | ------------------------------------------------- |
| `--port`        | Port the proxy listens on                          |
| `--origin`      | Origin server URL to forward requests to           |
| `--clear-cache` | Clear the cache of a running instance and exit     |

## Example: start the proxy

```sh
npx tsx src/cli.ts --port 3000 --origin http://dummyjson.com
```

## curl test commands

Basic request — first call is a MISS, second is a HIT:

```sh
curl -sD - -o /dev/null http://127.0.0.1:3000/products/1 | grep -i x-cache   # MISS
curl -sD - -o /dev/null http://127.0.0.1:3000/products/1 | grep -i x-cache   # HIT
```

Full response with headers and body:

```sh
curl -s -D - -o /tmp/body.json http://127.0.0.1:3000/products/1
```

Clear the cache over HTTP directly:

```sh
curl -s -D - -o - -X DELETE http://127.0.0.1:3000/_cache
```

POST request (body forwarded, not cached):

```sh
curl -s -D - -o /dev/null -X POST http://127.0.0.1:3000/products/add \
  -H "Content-Type: application/json" -d '{"title":"test"}'
```

Confirm no double-compressed/duplicated headers:

```sh
curl -sL -D - -o /dev/null --compressed http://127.0.0.1:3000/products/1 | \
  grep -iE "content-encoding|content-length|transfer-encoding|^HTTP"
```

Malformed request-target (expect `400`):

```sh
curl -s -D - -o - -x http://127.0.0.1:3000 http://example.com/anything
```

## How caching works

- Only `GET` requests with a `2xx` upstream response are cached.
- Cache key is `METHOD:URL`.
- Entries expire after 60 seconds (`TTL_MS` in `src/index.ts`).
- Cache is capped at 100 entries (`MAX_ENTRIES`); oldest entry is evicted
  (LRU, not FIFO) when a new entry is stored past that limit.
- `Set-Cookie` and hop-by-hop headers (`Connection`, `Transfer-Encoding`, etc.)
  are stripped from cached/replayed responses to avoid leaking session state
  between clients.
- Redirects from the origin are only auto-followed for `GET`/`HEAD` when the
  `Location` host matches the origin host — anything else is relayed as-is to
  the client, not followed server-side.

## License

ISC
