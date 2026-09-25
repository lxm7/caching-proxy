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
```

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
