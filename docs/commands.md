# Validation commands

Key checks per milestone. Automated tests are the source of truth; the curls
are for eyeballing a live proxy against dummyjson.com.

## Setup

```sh
npx tsx src/cli.ts --port 3000 --origin http://dummyjson.com   # dev, from source
pnpm build && node dist/cli.js --port 3000 --origin http://dummyjson.com   # what ships
lsof -ti:3000 | xargs -r kill   # free the port from a previous run
```

`dist/` only changes on `pnpm build` — if `dist/index.js` is older than
`src/index.ts`, you're testing stale code.

## Automated tests

```sh
npx tsc -p tsconfig.json --noEmit
npm test
npx tsx --test --test-timeout=20000 --test-name-pattern="gzipped" src/cache.test.ts   # one test by name
npx tsx --test --test-name-pattern="B10" src/admin.test.ts   # clear-mid-fetch race, step 6a
npx tsx --test --test-name-pattern="B6" src/abort.test.ts    # client-disconnect abort, step 9a
npx tsx --test --test-name-pattern="504" src/timeout.test.ts # upstream-timeout 504, step 8a
npx tsx --test --test-name-pattern="TTL has elapsed" src/cache.test.ts # TTL-from-headers regression, step 16a
```

The `--test-name-pattern="504"` line above, plus `npm test` (x3), were re-run after fixing
`timeout.test.ts`'s config setup (it was mutating the shared `DEFAULT_CONFIG` singleton
and reverting it before any request was handled) to confirm the flake is gone.

`npx tsc --noEmit` and `npm test` were re-run after Phase C chunk 1 (steps 11-14: credential
bypass, `Cache-Control` on store, partial-content exclusion, request-header forwarding) and
again after chunk 2 (steps 15-16: `Vary`-aware keying, TTL from origin headers). Chunk 2
required rewriting the TTL-elapsed test above: it used to fake expiry by mocking `Date.now()`,
which no longer works now that freshness is checked against `performance.now()` (16a, by
design — a wall-clock jump must not expire or revive entries) — it now uses a real short
`ttlMs` and a real wait instead.

Each test runs its own stub origin and proxy on port `0` — no live upstream,
no clash with a proxy on 3000.

## CLI

```sh
npx tsx src/cli.ts --port 3000                               # error: missing --origin
npx tsx src/cli.ts --port abc --origin http://dummyjson.com  # error: invalid --port
npx tsx src/cli.ts --clear-cache                             # "Cleared N entries"

# EADDRINUSE (B9, step 5a) — second instance on the same port
npx tsx src/cli.ts --port 3000 --origin http://dummyjson.com &
npx tsx src/cli.ts --port 3000 --origin http://dummyjson.com   # "port 3000 in use", exits 1

# --timeout flag (B7, step 8b)
npx tsx src/cli.ts --port 3001 --origin http://dummyjson.com --timeout abc   # error: invalid --timeout
npx tsx src/cli.ts --port 3001 --origin http://dummyjson.com --timeout 5000 &
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/products/1   # 200 — valid --timeout doesn't break normal requests

# Graceful shutdown (step 10a/10b)
npx tsx src/cli.ts --port 3002 --origin http://dummyjson.com &
kill -INT $!   # clean exit 0, logs "shutting down..."

# Drain: a slow origin + an in-flight request, SIGINT while it's still buffering,
# assert the client still gets its response and the proxy exits 0 (not killed mid-request).
# Forced-close: temporarily set DRAIN_TIMEOUT_MS below the slow response's delay,
# same setup, assert the client gets status=000 and the proxy exits 1.
```

The `--port abc`, `--clear-cache` and EADDRINUSE lines above were re-run unchanged after
step 7a (`defineFlag`/config-object refactor) to confirm identical error text and behaviour
post-refactor.

## Cache: MISS → HIT → TTL → LRU → clear

```sh
xc() { curl -s -o /dev/null -w '[%header{x-cache}] http=%{http_code}\n' "$@"; }
xc http://127.0.0.1:3000/products/1   # [MISS] http=200
xc http://127.0.0.1:3000/products/1   # [HIT]  http=200
sleep 61; xc http://127.0.0.1:3000/products/1   # [MISS] — TTL expired

# LRU (fresh cache): 101 keys evicts the first
for i in $(seq 1 101); do curl -s -o /dev/null http://127.0.0.1:3000/products/$i; done
xc http://127.0.0.1:3000/products/1   # [MISS] — evicted

curl -s -X DELETE http://127.0.0.1:3000/_cache   # Cleared N entries
```

`http=000` means nothing is listening — not a cache state.

## Redirects and error paths

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/products/1   # 200 — same-host http→https followed
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/products/add -d '{}'   # 301 — body requests never follow
curl -s -x http://127.0.0.1:3000 http://example.com/   # 400 — absolute-form target rejected
```

Cross-host redirects and 502-on-unreachable are covered by the automated tests.

SSRF lock (B1, step 1a): any path resolving off the origin is a 400, with no
upstream log line. `--request-target` sends the path verbatim; plain curl
would normalise `//` and `\`.

```sh
sc() { curl -s -o /dev/null -w '%{http_code}\n' --request-target "$1" http://127.0.0.1:3000; }
sc '//example.com/'    # 400 — scheme-relative path to another host
sc '/\example.com/'    # 400 — `\` is treated as `/` for http(s)
sc '//[bad'            # 400 — unparseable, proxy stays up
npx tsx --test --test-name-pattern='host" request-target' src/admin.test.ts
```

## Origin behaviour reference (dummyjson.com)

```sh
curl -sD - -o /dev/null https://dummyjson.com/products/1
curl -sD - -o /dev/null -X POST https://dummyjson.com/auth/login -H "Content-Type: application/json" -d '{"username":"emilys","password":"emilyspass"}'
TOKEN=$(curl -s -X POST https://dummyjson.com/auth/login -H "Content-Type: application/json" -d '{"username":"emilys","password":"emilyspass"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['accessToken'])")
curl -sD - -o /dev/null https://dummyjson.com/auth/me -H "Authorization: Bearer $TOKEN"
```

Checked ahead of item 12's `Cache-Control: public` override (Phase C, chunk 1): dummyjson never
sends `public` on any of these — `/products/1` sends `no-store`, `/auth/login` and `/auth/me`
send no `Cache-Control` header at all. Informed the decision to keep the override store-side
only (no read-side symmetric case), tested against a local stub rather than live dummyjson.

## Open bugs (see `plan.md`)

Header forwarding — B4, step 14a:

```sh
curl -s -H 'Authorization: Bearer x' http://127.0.0.1:3000/auth/me
```
Fixed: `Invalid/Expired Token!`. Currently `Access Token is required` — the
header never reaches the origin.

Crash when upstream dies mid-body — B2, step 2a (becomes an automated test):

```sh
cat > /tmp/crash.mts <<'EOF'
import { createServer } from "node:http";
const { startServer } = await import(process.env.PROXY_SRC!);
const origin = createServer((_req, res) => {
  res.writeHead(200); res.write("partial");
  setTimeout(() => res.socket?.destroy(), 50);
}).listen(0, "127.0.0.1", () => {
  const proxy = startServer({ port: 0, origin: `http://127.0.0.1:${(origin.address() as any).port}` });
  proxy.on("listening", async () => {
    await fetch(`http://127.0.0.1:${(proxy.address() as any).port}/x`).then((r) => r.text()).catch(() => {});
    setTimeout(() => { console.log("PROXY STILL ALIVE"); process.exit(0); }, 300);
  });
});
EOF
PROXY_SRC="$PWD/src/index.ts" npx tsx /tmp/crash.mts
```
Fixed: `PROXY STILL ALIVE`. Currently exits with `Unhandled 'error' event`.
`.mts` because the package is CommonJS and the script uses top-level `await`.
