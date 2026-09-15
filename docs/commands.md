# Validation commands

Commands used to verify `src/index.ts` behaves as intended.

## Start the proxy

```sh
npx tsx src/index.ts
```

## Confirm upstream status/headers/body are relayed

```sh
curl -s -D - -o /tmp/body.json http://127.0.0.1:3000/products/1
```

Expected: upstream's actual status line (e.g. `301` from dummyjson.com's
http→https redirect) and headers (`content-type`, `location`, Cloudflare
headers) come through as-is, with the upstream body saved to `/tmp/body.json`.

## Confirm request body is piped upstream (non-GET)

```sh
curl -s -D - -o /dev/null -X POST http://127.0.0.1:3000/products/add \
  -H "Content-Type: application/json" \
  -d '{"title":"test"}'
```

Expected: proxied request reaches upstream with the body intact (same
status/header relay as GET).

## Confirm hop-by-hop headers aren't double-sent

```sh
curl -sL -D - -o /dev/null --compressed http://127.0.0.1:3000/products/1 | \
  grep -iE "content-encoding|content-length|transfer-encoding|^HTTP"
```

Expected: no duplicated or conflicting `content-encoding`/`transfer-encoding`
values — these are stripped from the upstream response before relaying so
Node's own response framing isn't fighting the proxied ones.

## Confirm 502 on unreachable upstream

Point a scratch copy of `src/index.ts` at an unreachable `ORIGIN` (e.g.
`http://127.0.0.1:9`) on a spare port, then:

```sh
curl -s -D - -o /dev/null http://127.0.0.1:3001/x
```

Expected: `HTTP/1.1 502 Bad Gateway` and an `ECONNREFUSED` logged server-side.

## Free port 3000 if a previous run was left listening

```sh
lsof -ti:3000 | xargs -r kill
```
