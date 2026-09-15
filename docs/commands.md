# Validation commands

Commands used to verify `src/index.ts` behaves as intended.

## Start the proxy

```sh
npx tsx src/index.ts
```

Detached, for running curl batches against it:

```sh
nohup npx tsx src/index.ts > /tmp/cache-proxy-test.log 2>&1 &
disown
```

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

## Free port 3000 if a previous run was left listening

```sh
lsof -ti:3000 | xargs -r kill
```
