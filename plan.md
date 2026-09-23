# Cache Proxy — Plan

Source of truth for behaviour: `docs/requirements.md`. This file tracks what
shipped for the MVP, then the roadmap: the pieces that separate a demo proxy
from one you'd actually trust in front of a real API.

## Stack

Node v22 runtime, TypeScript (native compiler). Node core only — `node:http`
(`createServer`), `fetch`/undici for the upstream leg, `node:util`
(`parseArgs`). No proxy or CLI libraries, no disk/Redis persistence: the
in-memory `Map` is valid *because* `--clear-cache` is an HTTP call into the
same live process, not a separate reach into someone else's memory. That
constraint holds for everything below — nothing on this list needs a second
process or a datastore.

## Status: MVP shipped

- CLI: `--port`, `--origin`, `--clear-cache` (`src/cli.ts`).
- Single `http.createServer` handler (`src/index.ts`): cache lookup on
  `method:url.href`, MISS forwards via `fetch`, buffers the body, stores it.
- `DELETE /_cache` admin route, checked before any proxy logic so the CLI
  flag can flush a live process over HTTP.
- TTL (60s) + LRU eviction at 100 entries, *and* a byte budget (1MB/entry,
  5MB total) with oldest-first eviction once either cap is hit.
- SSRF-guarded redirect handling: a same-host `http→https` redirect on a
  bodyless request is resolved into a cacheable 2xx; a cross-host redirect is
  relayed as a 3xx, never followed.
- `Set-Cookie` stripped from anything that goes into the shared cache (one
  client's session must not replay to the next caller).
- Test coverage: cache hit/miss/eviction, redirect handling incl. the
  cross-host case, admin route incl. origin-down behaviour.

## Roadmap — the top 10 pieces of a proper HTTP cache

What makes a cache proxy *proper* isn't more features, it's not being wrong
in ways nobody notices until it's in front of real traffic. The order below
is triage order, not interest order — it's roughly the order these bugs get
found in a real deployment, worst blast-radius first. Two correctness bugs
(no. 1, no. 2) currently outrank the throughput feature (no. 5) that would
otherwise be the obvious "add value" move, because right now that feature
would just make the wrong response arrive faster and get shared wider.

Confirmed live against a stub origin (`startServer` in-process, no live
`dummyjson.com` dependency):

**Client request headers are silently dropped.** `fetchUpstream`
(`src/index.ts:98-108`) sends `method`, `body`, `redirect` — no `headers`.
`Authorization`, `Accept`, a POST's `Content-Type`: none of it reaches the
origin. Only undici's own defaults go out.

**Every compressed upstream response is truncated.** `content-encoding` is
stripped from the relayed headers (`src/index.ts:9-19`) and `fetch` decodes
the body, but `content-length` is relayed verbatim (`src/index.ts:142-157`).
Origin sends 46 gzip bytes framing 2012 bytes of JSON; Node honours the
`content-length` header and cuts the socket at byte 46. No error surfaces —
the client just gets a truncated body, and the cache stores the full 2012
bytes, so the HIT path repeats the mismatch. Any origin that gzips (most of
them) is corrupted today.

Fixing those two is a prerequisite for no. 3: forwarding headers without
fixing the cache key is how you turn a URL-keyed cache into a place where one
authenticated user's response body gets handed to the next anonymous caller.

---

### 1. Stop relaying a `content-length` that no longer describes the body

**Why:** confirmed data corruption, above. Security-adjacent — a truncated
JSON body can parse as a different, still-valid document downstream. Highest
severity, smallest diff.

**Change:** drop `content-length` from relayed + cached headers whenever the
body is re-encoded. Node then chunks the MISS response and computes length
itself on replay.

**Options:** always drop it *(recommended — maintainability: one entry in
the existing strip-set, trivially testable with a gzip stub)*, vs. drop only
when `content-encoding` was present (same fix, but couples two header
decisions — easy to reintroduce), vs. stop decoding altogether and cache the
compressed bytes with `content-encoding` intact keyed on `Vary:
Accept-Encoding` (the efficiency-optimal end state — cuts JSON entry size
~4-6× so the 5MB budget holds far more — but a rewrite of the fetch layer;
belongs after no. 7). This third option is exactly what nginx/Varnish do by
default: cache the wire representation, not the decoded one.

**Touches:** `src/index.ts:9-19, 142-157`. Regression test: gzip stub,
assert received byte count equals decoded length.

### 2. Forward client request headers upstream

**Why:** confirmed dropped, above. Breaks auth, content negotiation, and
conditional requests — the proxy can't front any API that needs a key.

**Change:** copy `req.headers` into the fetch init minus hop-by-hop headers
and `host` (undici must derive `host` from the target URL; forwarding the
client's `host` is a cache-poisoning vector). Add `X-Forwarded-For` /
`X-Forwarded-Proto` / `Via`.

**Edge cases:** array-valued headers need flattening; inbound
`content-length` must be dropped (body is streamed, not measured); inbound
`accept-encoding` should be normalised rather than passed raw, or the
origin's encoding choice varies per client while the cache key doesn't.

**Must not ship alone** — see no. 3.

**Touches:** `src/index.ts:96-108`.

### 3. Make the cache key honest: `Vary`, auth, private responses

**Why:** the key is `method:url.href` (`src/index.ts:28-30`) and nothing
else. That's only survivable today because no. 2 is broken. The moment
`Authorization` is forwarded, one user's response is stored under a
URL-only key and served to the next anonymous caller — the same class of
leak `Set-Cookie` stripping already guards against for headers, but for the
body.

**Change, in order:**
1. Never cache a request carrying `Authorization` or `Cookie` — MISS every
   time, relay through.
2. Never cache a response carrying `Cache-Control: private` or `no-store`.
3. Honour `Vary`: fold the named request headers into the cache key; treat
   `Vary: *` as uncacheable.

Step 1's real alternative — keying on a hash of the credential, correct per
RFC 9111 §3.5 — is not worth the risk here: one hashing mistake is a
cross-user leak, and it needs salting, constant-time comparison, and
eviction interaction to do safely. That's the right call only once there's
an actual multi-tenant workload behind this; for now, bypass is strictly
safer and a two-line predicate.

**Touches:** `src/index.ts:28-30, 72-94, 161-162`.

### 4. Honour HTTP cache semantics instead of a fixed 60s TTL

**Why:** `TTL_MS` applies unconditionally (`src/index.ts:4, 75`). A
`no-store` response gets cached; a `max-age=86400` response gets thrown away
after 60 seconds. The proxy is simultaneously less safe and less useful than
the origin asked for.

**Change:** parse response `Cache-Control` (`no-store`, `no-cache`,
`private`, `max-age`, `s-maxage`) and `Expires`; fall back to `TTL_MS` only
when the origin says nothing. Honour request-side `no-cache` (forced
revalidate) and `no-store`. Emit `Age` on HIT, refresh `Date`.

**Trade-off:** correctness costs hit-rate — an origin that sends `no-store`
liberally will make the cache look useless. That's the origin's call, not
the proxy's to override; a `--ignore-origin-cache-control` escape hatch (see
no. 8) keeps a demo path available without making it the default.

**Touches:** `src/index.ts:72-94, 161-205`.

### 5. In-flight request coalescing (single-flight)

**Why:** N concurrent misses on the same key currently issue N upstream
fetches (`src/index.ts:110-118`). A `seq 100 | xargs -P 100` burst is a
100× origin amplification — a thundering herd against the origin, and 100
simultaneous full-body buffers in flight against the byte budget, so the
memory cap is bypassed under concurrency even though it holds fine
sequentially. This is the item that makes the byte budget mean something
under load, which is why it can't ship before the budget exists.

**Change:** `Map<string, Promise<CacheEntry>>` of in-flight fetches
alongside the cache. A miss registers its promise before awaiting;
concurrent misses on the same key await that promise and replay the
resolved entry. Delete in a `finally` so a rejected fetch doesn't pin a
dead promise for everyone waiting on it.

**Edge cases:** a coalesced waiter needs its own `X-Cache` semantics (`MISS`
for the leader; followers are arguably `HIT` — pick one, document it).
Entries too large to cache can't be replayed to waiters at all, so those
waiters fall through to their own fetch. A client abort must not cancel the
leader's fetch out from under everyone else waiting on it.

**Alternative outside the stack:** nginx `proxy_cache_lock`, Varnish request
coalescing, or a Cloudflare Worker on the Cache API all do this natively,
and better. Worth a README line that this reimplements it deliberately as
an exercise, not as a recommendation to roll your own in production.

**Touches:** `src/index.ts:32-46, 110-118, 161-205`.

### 6. Conditional revalidation and stale serving

**Why:** on TTL expiry the entry is deleted (`src/index.ts:89-93`) and
re-fetched in full, even when nothing changed. Most origins would answer
`304 Not Modified` with no body at all — this is the difference between
re-downloading 2KB of JSON and re-downloading nothing.

**Change:** store `etag` / `last-modified` on the entry; on expiry send
`If-None-Match` / `If-Modified-Since`; on `304`, refresh `cachedAt` and serve
the stored body unchanged. Add `stale-if-error`: when the origin is
unreachable, serve an expired entry with `Warning`/`Age` instead of today's
flat 502 (`src/index.ts:115`) — a cache that goes as dark as the origin the
moment the origin has a bad day isn't buying you anything. Optionally
`stale-while-revalidate`: serve stale immediately, refresh in the
background.

**Trade-off:** stale-on-error is an availability dial, not a free win — make
it opt-in (`--stale-if-error <seconds>`), because silently serving stale
data during an outage is the wrong choice for some callers and they need to
be able to say no.

**Touches:** `src/index.ts:21-26, 89-118, 183-205`.

### 7. Timeouts, stream error handling, abort propagation

**Why:** three resource leaks, all durability issues for the *process*, not
the data:
- No timeout on `fetchUpstream` (`src/index.ts:98-108`) — a hanging origin
  holds a client socket and a buffered entry indefinitely.
- No `server.headersTimeout` / `requestTimeout` — slow-header clients
  (Slowloris-style) hold connections open for free.
- `upstreamStream.pipe(res)` (`src/index.ts:207`) doesn't forward errors. If
  the client disconnects mid-body, `res` errors but `upstreamStream` is
  never destroyed and its `end` handler never fires — the upstream socket
  and whatever was buffered leak silently.

**Change:** `AbortSignal.timeout(n)` on both fetch calls; `stream.pipeline()`
instead of `pipe()`; `req.on("close")` aborting the upstream fetch when the
client goes away (coordinated with no. 5 — don't abort a fetch other
waiters still need); explicit `headersTimeout` / `requestTimeout` /
`keepAliveTimeout` on the server.

**Touches:** `src/index.ts:98-118, 164-211, 213-215`.

### 8. Configurable knobs and a stats endpoint

**Why:** `TTL_MS`, `MAX_ENTRIES`, `MAX_ENTRY_BYTES`, `MAX_BYTES` are module
constants (`src/index.ts:4-7`) — changing any of them means editing source
and rebuilding. There's also no way to see cache state short of reading the
log line by line.

**Change:** `--ttl`, `--max-entries`, `--max-bytes`, `--max-entry-bytes`,
`--host`, `--log-level` in `parseArgs` (`src/cli.ts:9-15, 44-56`), validated
the same way `parsePort` already is, threaded through `startServer`'s
options object. Add `GET /_cache/stats` → `{ entries, totalBytes, hits,
misses, evictions, oldestAge }` next to the existing `DELETE /_cache`.

**Also here:** logging. `console.log` fires per request unconditionally
(`src/index.ts:57`) and prints the full URL including the query string —
which is where API keys live. Add levels; redact query values at `info` and
below.

**Touches:** `src/cli.ts:5-15, 37-85`; `src/index.ts:4-7, 32-70`.

### 9. Graceful shutdown and admin-endpoint hardening

**Why:** `SIGINT`/`SIGTERM` kills in-flight requests mid-body today —
restarting the proxy truncates whatever was streaming through it at that
moment. And `DELETE /_cache` (`src/index.ts:63-70`) is unauthenticated: the
127.0.0.1 bind (`src/index.ts:213`) is doing the *entire* job of keeping
that safe. Any local process can flush the cache, and the route shadows a
real origin path if the origin ever happens to serve `/_cache`.

**Change:** `server.close()` plus a drain deadline on `SIGINT`/`SIGTERM`.
For the admin surface: an optional `--admin-token` compared with
`crypto.timingSafeEqual` (never `===` — timing side-channel on a secret
comparison), and `--admin-prefix` so the reserved namespace can move off a
colliding origin path.

**Trade-off:** a token on a loopback-only demo proxy is close to theatre —
the real control is the bind address. Add it *only* alongside no. 8's
`--host`, since that's the flag that lets someone bind `0.0.0.0` and make
the token matter. State that coupling explicitly in the README so it isn't
mistaken for real auth on its own.

**Touches:** `src/index.ts:59-70, 213-218`; `src/cli.ts:44-56`.

### 10. Close the test gaps these changes open

**Why:** `docs/commands.md` already concedes the SSRF guard is untested
end-to-end — "guarantee is structural," not verified by a running test.
That's the one behaviour here where a silent regression is a security bug,
and the suite already has the machinery for it
(`src/utils/testHelpers.ts` spins a stub origin per test).

**Change:**
- Stub origin issuing a cross-host `Location` → assert the 3xx relays,
  isn't followed (covers `src/index.ts:124-137`).
- Gzip stub → assert received bytes equal decoded length (regression for
  no. 1).
- Header-echo stub → assert `Authorization` reaches the origin *and* the
  response isn't cached (regression for nos. 2 + 3 together — the second
  half of that assertion is the one that actually matters).
- Concurrent burst on one key → assert exactly one upstream fetch (no. 5).
- Client-disconnect mid-stream → assert the upstream socket is destroyed
  (no. 7).

**Touches:** `src/redirect.test.ts`, `src/cache.test.ts`,
`src/utils/testHelpers.ts`.

---

## Explicitly out of scope

- **Disk/Redis persistence.** Ruled out by design, not by oversight:
  `--clear-cache` works *because* the cache lives in the same process the
  CLI talks to over HTTP. Durability here means the process doesn't leak
  sockets or corrupt bytes while it's running (nos. 7, 9) — not that cache
  contents survive a restart. A restart clearing the cache is correct
  behaviour for this tool, not a gap.
- **Caching non-GET methods.** Correct invalidation semantics for writes is
  a materially larger piece of work than anything above and changes the
  proxy's risk profile (a stale cached write is a data-integrity bug, not a
  staleness annoyance).
- **HTTPS listener / TLS termination and any hosting/deployment concerns.**
  Origin-side HTTPS already works via `fetch`. Everything above is about
  what the proxy does with bytes it already has; where the process runs is
  a separate, later question.

## Suggested sequencing

Nos. 1–3 are one cluster, land together or in immediate succession — no. 2
without no. 3 is a regression in safety, not an improvement. Nos. 4–7 are
independent after that. Nos. 8–10 can land at any point; no. 10 should
trail each of the others by one commit rather than being saved for the end,
so the regression coverage exists before the next change lands on top of it.

## Cost note

$0 throughout — local CLI, no runtime dependencies, no infra. The one cost
axis that's real is **origin request volume**, and nos. 5 and 6 are the two
items that reduce it: no. 5 by roughly the burst concurrency factor, no. 6
by the 304-vs-200 body size difference.
