# Validation commands

Commands used to verify `src/index.ts` behaves as intended.

## Start the proxy

```sh
npx tsx src/index.ts
```

To validate against a running server without blocking the shell (e.g. before
a batch of `curl` checks), start it detached and tail the log separately:

```sh
nohup npx tsx src/index.ts > /tmp/cache-proxy-test.log 2>&1 &
disown
cat /tmp/cache-proxy-test.log
```

## Confirm upstream status/headers/body are relayed

```sh
curl -s -D - -o /tmp/body.json http://127.0.0.1:3000/products/1
```

Expected: `200` with the real product JSON in `/tmp/body.json`. GET has no
body to replay, so on a 3xx the proxy validates `Location`'s host against
`ORIGIN_HOST` and issues one bounded manual re-fetch — this is what resolves
dummyjson.com's http→https redirect into a real response, without letting
`fetch` auto-follow to an arbitrary upstream-controlled host (SSRF risk). See
"Confirm 3xx is relayed for methods with a body" for why non-GET differs, and
"Confirm cross-host redirect is not followed" for the rejection case.

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

## Confirm 3xx is relayed for methods with a body

```sh
node -e 'fetch("http://dummyjson.com/products/1", { redirect: "manual" }).then(res => console.log(res.status, res.headers.get("location")))'
```

Expected: `301 https://dummyjson.com/products/1` — confirms Node's `fetch`
exposes the real redirect response (status/headers) under `redirect:
"manual"` rather than the spec's opaque-redirect stub. The proxy always
fetches with `redirect: "manual"` (never lets `fetch` auto-follow — that
would blindly chase an upstream-controlled `Location`). For a request with a
body, a 3xx just relays to the client as-is (a followed redirect can't
re-send a request body already consumed as a stream — see "Confirm request
body is piped upstream" below); for GET/HEAD, the handler itself validates
`Location`'s host before doing one manual re-fetch.

## Confirm cross-host redirect is not followed

Not exercised end-to-end here — dummyjson.com has no route that redirects
off-host, and there's no mock origin set up in this repo to fake one. The
guarantee is structural, not empirically tested: `src/index.ts` only issues
the second `fetch` when `redirectTarget.host === ORIGIN_HOST`, and `.host`
includes the port, so a redirect to a different host or a different port on
the same host falls through to the untouched relay-3xx-as-is path instead.
Worth an actual test against a stub origin before relying on this.

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

## Confirm X-Cache MISS then HIT

```sh
curl -sD - -o /dev/null http://127.0.0.1:3000/products/1 | grep -i x-cache
curl -sD - -o /dev/null http://127.0.0.1:3000/products/1 | grep -i x-cache
```

Expected: first call `X-Cache: MISS` (origin relay path sets this
unconditionally), second call `X-Cache: HIT` (served from the in-memory
`cache` Map, no upstream fetch). Works with `ORIGIN` left as
`http://dummyjson.com` — GET uses `redirect: "follow"`, so the upstream
http->https redirect resolves to a 2xx internally and `cacheable` fires (see
"Confirm upstream status/headers/body are relayed" above).

## Free port 3000 if a previous run was left listening

```sh
lsof -ti:3000 | xargs -r kill
```
