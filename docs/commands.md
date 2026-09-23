# Validation commands

Commands used to verify `src/index.ts` behaves as intended.

## Start the proxy

```sh
npx tsx src/cli.ts --port 3000 --origin http://dummyjson.com
```

Detached, for running curl batches against it:

```sh
nohup npx tsx src/cli.ts --port 3000 --origin http://dummyjson.com > /tmp/cache-proxy-test.log 2>&1 &
disown
```

## Build and run from dist (what actually ships)

```sh
pnpm build
node dist/cli.js --port 3000 --origin http://dummyjson.com
```

`npx tsx src/cli.ts ...` above runs TypeScript source directly (dev only);
this runs the compiled plain-JS output `bin` actually points at, with no
`tsx`/`typescript` needed at runtime.

```sh
node dist/cli.js --clear-cache
```

## Clear the cache via the CLI

```sh
npx tsx src/cli.ts --clear-cache
```

Defaults to port `3000`; pass `--port <number>` if the server is running on
another one. Thin wrapper over the same `DELETE /_cache` route exercised
directly below — prints the "Cleared N entries" body and exits non-zero if
nothing is listening on that port.

## Confirm CLI arg validation

```sh
npx tsx src/cli.ts --port 3000                              # missing --origin
npx tsx src/cli.ts --port abc --origin http://dummyjson.com  # non-numeric port
npx tsx src/cli.ts --clear-cache --port 4999                 # nothing listening on 4999
```
Expected: each prints a clear one-line error to stderr and exits non-zero —
no stack trace.

## Redirect handling

```sh
curl -s -D - -o /tmp/body.json http://127.0.0.1:3000/products/1
```
Expected: `200`, real product JSON. GET/HEAD have no body to replay, so the
proxy validates `Location`'s host against `ORIGIN_HOST` and does one bounded
manual re-fetch, resolving dummyjson.com's http→https redirect into a 2xx
without letting `fetch` auto-follow to an upstream-controlled host (SSRF).

```sh
curl -s -D - -o /dev/null -X POST http://127.0.0.1:3000/products/add \
  -H "Content-Type: application/json" -d '{"title":"test"}'
```
Expected: `301` relayed as-is (not `502`) — a request body already consumed
as a stream can't be replayed on a followed redirect, hence `redirect:
"manual"` and no re-fetch for methods with a body.

Cross-host redirect rejection is not exercised end-to-end (no off-host
redirect route on dummyjson.com, no stub origin in this repo). Guarantee is
structural: `src/index.ts` only re-fetches when `redirectTarget.host ===
ORIGIN_HOST`.

## Confirm hop-by-hop headers aren't double-sent

```sh
curl -sL -D - -o /dev/null --compressed http://127.0.0.1:3000/products/1 | \
  grep -iE "content-encoding|content-length|transfer-encoding|^HTTP"
```
Expected: no duplicated/conflicting `content-encoding`/`transfer-encoding`.

## Confirm 502 on unreachable upstream

Point a scratch copy of `src/index.ts` at `ORIGIN = "http://127.0.0.1:9"` on
a spare port, then:

```sh
curl -s -D - -o /dev/null http://127.0.0.1:3001/x
```
Expected: `HTTP/1.1 502 Bad Gateway`, `ECONNREFUSED` logged server-side.

## Confirm 400 on malformed request-target

```sh
curl -s -D - -o - -x http://127.0.0.1:3000 http://example.com/anything
```
Expected: `HTTP/1.1 400 Bad Request`, body `Bad Request` — rejected before
any upstream call (absolute-form request-target, as an explicit-proxy client
would send).

## Confirm X-Cache MISS then HIT

```sh
curl -sD - -o /dev/null http://127.0.0.1:3000/products/1 | grep -i x-cache   # MISS
curl -sD - -o /dev/null http://127.0.0.1:3000/products/1 | grep -i x-cache   # HIT
```

## TTL test (60s window)

```sh
curl -s -D - -o /dev/null http://127.0.0.1:3000/products/1 | grep -i x-cache   # MISS
curl -s -D - -o /dev/null http://127.0.0.1:3000/products/1 | grep -i x-cache   # HIT
sleep 61
curl -s -D - -o /dev/null http://127.0.0.1:3000/products/1 | grep -i x-cache   # MISS again
tail -5 /tmp/cache-proxy-test.log   # expect EXPIRED GET:... in there
```

## Max-entries/LRU test

101 distinct keys, dummyjson has `/products/1`..`/products/100`:

```sh
for i in $(seq 1 100); do curl -s -o /dev/null http://127.0.0.1:3000/products/$i; done
curl -s -o /dev/null http://127.0.0.1:3000/products/101   # 101st insert, should evict products/1
grep -c STORED /tmp/cache-proxy-test.log     # expect 101
grep EVICTED /tmp/cache-proxy-test.log        # expect one line, evicting GET:.../products/1
curl -s -D - -o /dev/null http://127.0.0.1:3000/products/1 | grep -i x-cache   # MISS (evicted)
curl -s -D - -o /dev/null http://127.0.0.1:3000/products/2 | grep -i x-cache   # HIT (still cached)
```

Note: run this against a fresh cache (restart the server first). Re-querying
an already-evicted key re-stores it and, since the cache is still at
capacity, evicts the *next* LRU entry — so checking a "survivor" key right
after checking an evicted one can itself get evicted first.

## Confirm DELETE /_cache clears the cache

```sh
curl -s -o /dev/null http://127.0.0.1:3000/products/1
curl -s -o /dev/null http://127.0.0.1:3000/products/2
curl -s -o /dev/null http://127.0.0.1:3000/products/3
curl -s -D - -o - -X DELETE http://127.0.0.1:3000/_cache   # Cleared 3 entries
curl -s -D - -o /dev/null http://127.0.0.1:3000/products/1 | grep -i x-cache   # MISS
curl -s -D - -o - -X DELETE http://127.0.0.1:3000/_cache   # Cleared 1 entries
```
Expected: count in the response matches entries present at the time of the
call; handled locally before any upstream fetch, so it works even if the
origin is unreachable.

## Free port 3000 if a previous run was left listening

```sh
lsof -ti:3000 | xargs -r kill
```

## Confirm the listener is running the code you just edited

```sh
ps -o pid,etime,command -ax | grep -E 'tsx|cli\.ts|dist/cli' | grep -v grep
ls -l dist/index.js src/index.ts
```

A `node dist/cli.js` listener serves whatever was compiled last, so an edit to
`src/index.ts` changes nothing until `pnpm build` plus a restart — the repro
then "passes" against the old behaviour. Compare mtimes; if `dist` is older
than `src`, rebuild or run the source directly:

```sh
npx tsx src/cli.ts --port 3000 --origin http://dummyjson.com
```

## Distinguish a dead proxy from a cache state

`%header{x-cache}` is empty when there is no response at all, so a crashed
proxy prints blank lines that look like a third cache state. Always carry the
status code:

```sh
curl -s -o /dev/null -w '[%header{x-cache}] http=%{http_code}\n' "http://127.0.0.1:3000/products/1"
```
`http=000` with curl exit 7 means connection refused - nothing is listening.

Same for a concurrent burst:

```sh
seq 100 | xargs -P 100 -I{} curl -s -o /dev/null -w '%{http_code} %header{x-cache}\n' "http://127.0.0.1:3000$K" | sort | uniq -c
```

## Capture a proxy crash trace

stderr is unbuffered and stdout is not, so `> log 2>&1` interleaves them and
shreds the stack trace - a `node:events:497 / throw er;` survives with its
message overwritten. Split the streams and burst from a second terminal:

```sh
npx tsx src/cli.ts --port 3000 --origin http://dummyjson.com > /tmp/cache-proxy.out 2> /tmp/cache-proxy.err
cat /tmp/cache-proxy.err
```

## Run automated tests

```sh
npx tsc -p tsconfig.json --noEmit
npm test
```

`npm test` runs `tsx --test --experimental-test-coverage` over `src/**/*.test.ts`
(see `package.json`) and prints a line/branch/function coverage report at the
end. Each test spins up its own stub origin (`node:http`) and its own
`startServer` instance on port `0`, so tests don't collide with a manually
running proxy on port 3000 and don't depend on a live upstream like
dummyjson.com. TTL expiry is exercised via `node:test`'s built-in
`t.mock.timers` (faking `Date` only) instead of a real 60s wait.

## Probe: are client request headers forwarded, and is `content-length` still valid?

Neither behaviour is reachable with `curl` against dummyjson.com — one needs an
origin that echoes back what it received, the other an origin that gzips with a
known decoded size. Both use an in-process stub instead of the live upstream.

Write the probe to the scratch directory (not the repo):

```sh
cat > /tmp/probe.mjs <<'PROBE'
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
const { startServer } = await import(process.env.PROXY_SRC);

const payload = Buffer.from(JSON.stringify({ hello: "x".repeat(2000) }));
const gz = gzipSync(payload);

const origin = createServer((req, res) => {
  if (req.url === "/echo-headers") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ got: req.headers }));
    return;
  }
  res.writeHead(200, {
    "content-type": "application/json",
    "content-encoding": "gzip",
    "content-length": String(gz.byteLength),
  });
  res.end(gz);
});
await new Promise((r) => origin.listen(0, "127.0.0.1", r));
const oPort = origin.address().port;

const proxy = startServer({ port: 0, origin: `http://127.0.0.1:${oPort}` });
await new Promise((r) => proxy.once("listening", r));
const pPort = proxy.address().port;

const r1 = await fetch(`http://127.0.0.1:${pPort}/echo-headers`, {
  headers: { authorization: "Bearer SECRET", "x-custom": "abc", accept: "application/json" },
});
console.log(JSON.stringify((await r1.json()).got, null, 2));

const r2 = await fetch(`http://127.0.0.1:${pPort}/gz`);
const body = Buffer.from(await r2.arrayBuffer());
console.log("content-length:", r2.headers.get("content-length"));
console.log("content-encoding:", r2.headers.get("content-encoding"));
console.log("gzip", gz.byteLength, "decoded", payload.byteLength, "received", body.byteLength);

proxy.close(); origin.close();
PROBE
PROXY_SRC="$PWD/src/index.ts" npx tsx /tmp/probe.mjs
```

The quoted `<<'PROBE'` heredoc stops the shell touching the script's backticks
and `${}` template literals, which is also why the source path arrives via
`PROXY_SRC` and a dynamic `import()` rather than being interpolated in — run it
from the repo root.

Expected, once the issues in `plan.md` nos. 1-2 are fixed:

- the echoed header set contains `authorization`, `x-custom` and
  `accept: application/json` — currently it contains only undici's own defaults,
  so no client header reaches the origin (`src/index.ts:98-108` passes no
  `headers`).
- `received` equals `decoded`, not `gzip` — currently the proxy strips
  `content-encoding` but relays `content-length` verbatim
  (`src/index.ts:142-150`), so Node cuts the body at the compressed length and
  the client silently gets a truncated response.

Port `0` on both the stub origin and `startServer` keeps this clear of a proxy
left listening on 3000, same as the automated tests.
