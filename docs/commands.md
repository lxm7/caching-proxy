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

Expected: proxied request reaches upstream with the body intact, and gets
back the same `301` relay as GET (not a `502` — `fetch`'s default
redirect-following can't replay a consumed streaming body on a followed
redirect, hence `redirect: "manual"` in the fetch call).

## Confirm 3xx is relayed, not silently followed

```sh
node -e 'fetch("http://dummyjson.com/products/1", { redirect: "manual" }).then(res => console.log(res.status, res.headers.get("location")))'
```

Expected: `301 https://dummyjson.com/products/1` — confirms Node's `fetch`
exposes the real redirect response (status/headers) under `redirect:
"manual"` rather than the spec's opaque-redirect stub, which is what makes
relaying 3xx through this proxy possible at all.

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

## Confirm 400 on malformed request-target

Origin-form (`req.url` undefined, unreachable via curl) and syntactically
invalid targets get rejected by Node's own HTTP parser before reaching our
handler. To reach the app-level 400 guard, send a syntactically valid
absolute-form request-target (what an explicit-proxy client sends), which
doesn't start with `/`:

```sh
curl -s -D - -o - -x http://127.0.0.1:3000 http://example.com/anything
```

Expected: `HTTP/1.1 400 Bad Request`, `Content-Type: text/plain`, body
`Bad Request` — request is rejected before any upstream call is made.

## Free port 3000 if a previous run was left listening

```sh
lsof -ti:3000 | xargs -r kill
```
