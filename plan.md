# Cache Proxy — Hardening Plan

Consolidates the old `plan.md` roadmap (deleted from the working tree, still at
`git show HEAD:plan.md`) with the 2026-09-25 bug review. Source of truth for behaviour
remains `docs/requirements.md`.

Constraints carried over unchanged: Node 22, TypeScript, Node core only, in-memory `Map`,
no second process or datastore. Cost is $0 throughout; the only real cost axis is **origin
request volume**, which items 17–18 reduce.

**Step size rule:** every item is broken into steps of roughly ≤10 changed lines of source
(tests excluded), each committable on its own with its own test. Where a step can't get
under ~10 lines without leaving the code broken, it's flagged **(unsplittable)** with the
reason. Line counts are estimates, not measurements.

## Already shipped

- MVP: CLI (`--port`, `--origin`, `--clear-cache`), `DELETE /_cache`, 60s TTL, LRU at 100
  entries, 1MB/entry + 5MB total byte budget.
- Same-host redirect follow for bodyless requests; cross-host redirects relayed, not
  followed (tested: `src/redirect.test.ts`).
- `Set-Cookie` never stored in the shared cache.
- `content-encoding` / `content-length` stripped from decoded bodies (old plan no. 1;
  tested: "gzipped origin response…" in `src/cache.test.ts`).

## Known bugs

| ID | Status | Bug | Fixed by |
|----|--------|-----|----------|
| B1 | **Reproduced** | `//host/x` or `/\host/x` request path resolves to another host via `new URL(req.url, origin)`, so the proxy fetches any host and caches it (SSRF). The redirect guard doesn't help: the first request already leaves the origin | 1 |
| B2 | **Reproduced** | Upstream dying mid-body crashes the process: `pipe()` doesn't forward errors, and there's no `'error'` listener on `Readable.fromWeb` | 2 |
| B3 | From reading | Malformed `Location`: `new URL(location, …)` throws outside any try in the async handler → unhandled rejection → crash | 3 |
| B4 | From reading | No request headers forwarded (`content-type`, `authorization`, `accept`, `range`) | 14 |
| B5 | From reading | Cache ignores `Cache-Control`, `Expires` and `Vary` | 11–16 |
| B6 | From reading | Client disconnect doesn't abort the upstream fetch. The upstream socket is either left stalled (not cacheable) or keeps downloading (cacheable) | 9 |
| B7 | From reading | No upstream timeout, and server timeouts are left at Node defaults | 8 |
| B8 | From reading | `DELETE /_cache` has no auth; reachable by any local process, and by a browser page when the upstream's OPTIONS answer allows it (preflight is sent to the origin and its answer relayed) | 20 |
| B9 | From reading | No `'error'` handler on `listen`, so `EADDRINUSE` exits with a stack trace | 5 |
| B10 | From reading | `DELETE /_cache` while a response is still buffering: the `'end'` handler stores the entry after the clear, so a cleared entry reappears | 6 |
| B11 | From reading, becomes live with 14 | 206 counts as cacheable 2xx. Once `Range` is forwarded, a partial body gets cached under the full URL key | 13 |

---

## Phase A — Stop the crashes and the SSRF

Independent of each other; land in any order. Highest severity, smallest diffs.

### 1. Lock the upstream origin (B1)
- **1a** (~5 lines) After `new URL(req.url, origin)`, return 400 unless
  `upstreamUrl.origin === new URL(origin).origin`. Hoist the parsed origin next to
  `ORIGIN_HOST`.
- Test: `//127.0.0.1:<other-stub>/x` and `/\evil.test/x` → 400, other stub hit count 0.
  Repro command in `docs/commands.md`.

### 2. Relay the body with `pipeline()` (B2)
- **2a** (~6 lines) Replace `upstreamStream.pipe(res)` with
  `pipeline(upstreamStream, res, err => …)`. On error, log it and `res.destroy(err)`
  (headers are already sent by then, so a 502 isn't possible).
- Test: stub writes part of the body, then destroys the socket. Assert the proxy survives
  and the next request is served. Repro command in `docs/commands.md`.

### 3. Guard the `Location` parse (B3)
- **3a** (~3 lines) Parse with `URL.canParse` (Node ≥19.9) or try/catch. If it can't be
  parsed, relay the 3xx as-is.
- Test: stub returns `Location: http://[bad`, assert the 3xx is relayed and the proxy
  survives.

### 4. Handler-level safety net
- **4a** (~12 lines, `src/index.ts` + `src/cli.ts`) Wrap the request handler body in
  try/catch: 502 if headers aren't sent yet, `res.destroy()` if they are. Log with the
  request's method and path. Same commit adds `process.on("unhandledRejection")` in
  `cli.ts` so a crash is loud rather than silent — a handler-level catch without a
  process-level one still lets other crash sources exit silently, so the two only make
  sense shipped together.

### 5. Clean failure on listen error (B9)
- **5a** (~5 lines, `src/cli.ts`) `server.on("error")`: print
  `port <n> in use` for `EADDRINUSE`, exit 1.

### 6. Make `DELETE /_cache` beat in-flight stores (B10)
- **6a** (~5 lines) A `generation` counter, incremented on clear. Each miss captures it
  before fetching; the `'end'` handler skips the store if it has changed.
- Test: slow stub. Start a request, clear the cache, let the request finish, then assert
  the next request is a MISS.

## Phase B — Resource limits

### 7. Configurable knobs — plumbing
- **7a** (~14 lines) Move `TTL_MS`, `MAX_*` and the timeout into a `config` object passed
  through `startServer`'s options, with the current constants as defaults. Add a shared
  `defineFlag(name, parse, validate)` helper (used by every CLI flag in this item and in
  Phase E) so each flag becomes a 2–3 line call instead of a hand-rolled `parsePort`-style
  block repeated five times. No new flags exposed yet.
- Moved earlier than the rest of "Configurable knobs" (originally Phase E, item 21) because
  8b and 20b need it — doing it here removes the forward dependency those items used to
  have on a step that hadn't happened yet.

### 8. Timeouts (B7)
- **8a** (~4 lines) `signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)` on `fetchUpstream`.
  Map `TimeoutError` to 504, not 502.
- **8b** (~3 lines) `--timeout <ms>` flag via `defineFlag`.
- **8c** (~4 lines) Set `headersTimeout`, `requestTimeout` and `keepAliveTimeout` on the
  server explicitly, to guard against slow clients that trickle headers (Slowloris) and to
  make the limits visible in code.
- Merged from two previously separate items (upstream fetch timeout + server-side
  timeouts): same bug, same test file, no reason to split the commit.

### 9. Abort upstream when the client leaves (B6)
- **9a** (~8 lines) An `AbortController` per request, aborted on `res` `'close'` if the
  response didn't finish. Combine it with 8a via `AbortSignal.any([...])`.
- Must be revisited when 17 lands: a follower disconnecting must not abort the leader's
  fetch.
- Test: stub streams slowly; client aborts; assert the stub sees its socket close.

### 10. Graceful shutdown
- **10a** (~6 lines, `src/cli.ts`) On SIGINT/SIGTERM: `server.close()`, exit when it
  finishes.
- **10b** (~5 lines) Drain deadline: after N seconds, `server.closeAllConnections()` and
  exit 1.

## Phase C — Correct caching

**Chunk 1 — land 11, 12, 13, 14 as one commit.** Forwarding headers (14) without the
other three turns the shared cache into a leak of one user's authorised responses to the
next caller. Bundled rather than split further: 11 (credential bypass) and 13 (partial-
content exclusion) are both unfalsifiable against a real origin until 14 forwards the
headers they guard (`Authorization`/`Cookie`, `Range`) — per the bug table, B11 "becomes
live with 14." Splitting them into their own commits buys no real bisect safety, since
neither has independently observable behaviour; it only produces synthetic-stub tests in
place of one real one. Internal order within the commit stays 11 → 12 → 13 → 14. Chunk 2
(15–16) follows after, as its own commit.

**Before starting 11:** reconsider whether `handleRequest` should split into a small
middleware pipeline (`(req, res, next) => void`, hand-rolled, no dependency — stays inside
the "Node core only" constraint). Not worth deciding earlier: by this point auth-bypass
(11), `Cache-Control` (12), `Vary` (15) and header forwarding (14) will show what a
pipeline stage actually needs to read/write, so the seams can be designed from real
shape instead of guessed. Doing it here also means every remaining Phase C–F item lands
as its own stage instead of growing the one function further. Not a blocker — plain
sequential code in `handleRequest` still works if the answer is "not yet."

### 11. Bypass the cache for credentialed requests
- **11a** (~4 lines) If the request has `authorization` or `cookie`, don't look it up;
  always MISS on the read side, unconditionally (12c only widens what can be *stored*, not
  what a credentialed request can read back). Keying on a credential hash (RFC 9111 §3.5)
  is deliberately not done: one mistake there is a cross-user leak.

### 12. Respect response `Cache-Control` on store
- **12a** (~8 lines) Small `parseCacheControl(header)` → `Map<directive, value|true>`.
- **12b** (~4 lines) Don't store `no-store`, `private`, or `Vary: *`.
- **12c** (~3 lines) Store-side-only override: widen `cacheable` so a credentialed
  request's response is still stored when the response carries `Cache-Control: public`
  (RFC 9111 §3.5's explicit exception). Deliberately store-side only — the *read* path
  keeps 11a's hard bypass unconditionally, so a credentialed request never gets served
  from the cache even for an entry stored under this override. A full symmetric version
  (a `public` flag on `CacheEntry`, checked on lookup so a credentialed *reader* can also
  get a HIT) was considered and dropped: checked live against dummyjson (`docs/commands.md`,
  "Origin behaviour reference") and it never sends `public` anywhere — `/products/1` sends
  `no-store`, `/auth/login` and `/auth/me` send no `Cache-Control` at all. Building the
  read-side branch now would add new `CacheEntry` state and a two-phase lookup in the same
  commit as header forwarding — the riskiest item in this plan — against zero real
  coverage. Revisit only if a real origin under test is ever seen sending `public` on a
  credentialed response.
- Test (12c): local stub, not dummyjson (which can't be made to emit `public`) —
  credentialed request to a `Cache-Control: public` response stores; a second credentialed
  request to the same URL still MISSes (read bypass holds); a third, anonymous request
  HITs the stored entry.

### 13. Never cache partial content (B11)
- **13a** (~2 lines) Restrict `cacheable` to status 200 (or exclude 206), and skip requests
  that have `range`.

### 14. Forward request headers (B4)
- **14a** (~10 lines) Allowlist copy from `req.headers`: `accept`, `accept-language`,
  `authorization`, `content-type`, `cookie`, `if-none-match`, `if-modified-since`,
  `range`, `user-agent`. Flatten array values. Never forward `host`, `content-length` or
  `accept-encoding` (undici sets and negotiates these itself). See decision D1.
- **14b** (~3 lines) Only attach a request body when the request declares one
  (`content-length > 0` or `transfer-encoding` present). Today DELETE and OPTIONS always
  send a streamed body, which some origins reject. *Unverified; confirm with an echo stub
  first.*
- Chunk-1 test (11/13/14): dummyjson end-to-end — log in as two different demo users
  (`POST /auth/login`), both `GET /auth/me` through the proxy with their own `Bearer`
  token; assert neither ever sees the other's profile and `X-Cache` is `MISS` both times.
  Plus a `Range` request against a real dummyjson response (not cached), and confirmation
  that `/products/1`'s real `Cache-Control: no-store` (`docs/commands.md`) isn't cached.
- `X-Forwarded-For` / `X-Forwarded-Proto` / `Via` moved to 24e: they don't fix B4, so they
  don't need to sit on Phase C's strict-order critical path.

**Chunk 2 — land 15 and 16 together, as one commit, after chunk 1.**

### 15. Honour `Vary`
- **15a** (~6 lines) Store the response's `Vary` header names on the `CacheEntry`.
- **15b** (~8 lines) Build the key as `method:href` + the values of those request headers.
  Lookup is two steps: find the entry by URL, then check whether the variant matches.
- **(unsplittable below ~14 lines)**: 15a on its own changes nothing a test can see; ship
  it with 15b.
- Kept as full per-header variant keying rather than "bypass cache on any `Vary`": origin
  request volume is the cost axis this whole plan optimises for, and a bypass rule works
  directly against it.

### 16. TTL from origin cache headers instead of a fixed 60s
- **16a** (~14 lines) Add `ttlMs` to the entry, from `s-maxage` > `max-age` > `Expires`,
  falling back to `TTL_MS`; the freshness check uses `entry.ttlMs`. Same step emits `Age`
  on a HIT and uses `performance.now()` for cache age, so a wall-clock jump can't expire or
  revive every entry at once — all three touch the same age/ttl computation, so splitting
  them added diffs without adding independently-testable behaviour.
- **16b** (~5 lines) Request-side `Cache-Control: no-cache` / `no-store` skip the lookup.

## Phase D — Origin load and availability

### 17. Single-flight: one upstream fetch per key — **shipped, well over the ~20-line estimate**
**(unsplittable below ~20 lines):** the leader/follower handoff doesn't work partly done;
a half-built version either double-fetches or leaves followers hanging. The estimate held for
the happy path; it didn't account for what 17c actually costs once you follow it through —
final diff was closer to 90 lines across `src/index.ts`, plus `src/singleflight.test.ts`.
- **17a** `Map<key, { promise: Promise<CacheEntry | null>; followerCount: number }>`, keyed by
  the same Vary-aware key as the cache itself (15b). The leader registers before fetching and
  removes itself via `promise.finally()`; followers await it and replay the entry, or —
  if it resolves `null` (not cacheable, too large, or cleared mid-fetch) — fall through to
  fetch independently. `null` is settled as soon as it's known (right after `cacheable` is
  computed, not after the body finishes), so followers of a non-cacheable leader don't wait
  out a download they can't use.
- **17b** Followers get `X-Cache: HIT-COALESCED` (D3).
- **17c** The leader's own client disconnecting must not abort a fetch followers are relying
  on: `clientAbort.abort()` is gated on `followerCount === 0`. That alone wasn't enough —
  two further problems only showed up once actually tested (see below), both now fixed:
  - **Every leader exit path must settle the promise**, not just the success path — both
    `fetchOrRelayError` failures, a bodyless response, and the two `on("end")` early-outs
    (generation mismatch, too-large) all needed an explicit `settleInFlight(null)`. Miss one
    and every follower for that key hangs forever, not just errors — worse than the bug this
    item fixes. (One gap remains, accepted: a synchronous throw during header-relay/cacheable
    computation itself — e.g. `res.setHeader` throwing for a reason unrelated to a dead
    connection — still isn't caught, and would wedge that one key until restart. Narrow,
    pre-existing-shape code, judged not worth a broader try/catch.)
  - **`pipeline()`/`.pipe(res)` on an already-destroyed `res` silently wedges the stream.**
    Found by actually testing 17c (client disconnects mid-fetch, followers still attached):
    by the time the origin responds, the leader's own `res` is already dead, and both
    `pipeline()` and plain `.pipe()` write to it as part of the stream's internal `'data'`
    dispatch — that write throws, and the throw kills `upstreamStream` with no more `data`/
    `end` ever firing, hanging every follower indefinitely. Fixed: skip pipe/pipeline
    entirely when `res.destroyed`; the buffering `data`/`end` listeners (already attached for
    caching) drive the stream to completion on their own regardless of `res`'s state.
- **Known accepted gap, shared with 15:** the very first concurrent burst for a URL that
  turns out to vary (no entry in `varyByUrl` yet) coalesces onto one fetch before the Vary
  axis is known — e.g. two simultaneous first-ever requests with different `Accept-Language`
  get the same coalesced response. Once `varyByUrl` is populated (after that first fetch),
  later concurrent requests correctly split into separate single-flight slots per variant.
  This is the same "first-store race" 15b already accepted (self-heals via TTL), sharpened
  by 17 into a guaranteed same-body case for that one initial burst rather than a narrow
  timing race. Not fixed here — would need probing/deferring coalescing until Vary is known.
- Test: `src/singleflight.test.ts` — 20 concurrent requests for one key → origin hit count 1,
  1 MISS + 19 `HIT-COALESCED`; leader disconnects mid-fetch with two followers attached →
  both followers still get served correctly, origin hit count still 1.

### 18. Conditional revalidation
- **18a** (~4 lines) Store `etag` / `last-modified` on the entry. Needs 14a so those
  headers aren't stripped.
- **18b** (~10 lines) When a cached entry has expired, keep it, send `If-None-Match` /
  `If-Modified-Since`; on 304, refresh `storedAt` and serve the stored body.

### 19. Opt-in `stale-if-error`
- **19a** (~8 lines) Expired entries stay in the map instead of being deleted on read
  (they're still bounded by the byte and entry caps). On upstream 5xx, timeout or
  network error, serve the stale entry with `X-Cache: STALE` and `Age`, if it's within
  the window.
- **19b** (~5 lines) `--stale-if-error <seconds>`, default 0 (off). Serving stale data
  during an outage has to be the caller's choice.

## Phase E — Admin surface, config, observability

### 20. Admin endpoint hardening (B8)
- **20a** (~5 lines) Reject admin requests whose `Host` isn't `127.0.0.1:<port>` or
  `localhost:<port>`. This blocks DNS rebinding from a browser, and it's needed even on a
  loopback bind.
- **20b** (~10 lines) `--admin-token` (or `CACHE_PROXY_ADMIN_TOKEN` env), checked against
  a `Bearer` header with `crypto.timingSafeEqual`. `--clear-cache` sends it. See D2.
- **20c** (~5 lines) `--admin-prefix` so `/_cache` can't shadow a real origin path.

### 21. Configurable knobs — flags
Plumbing (config object, `defineFlag` helper) now lives in item 7. Each flag below is a
`defineFlag` call.
- **21a–d** (~2–3 lines each) One flag per step: `--ttl`, `--max-entries`, `--max-bytes`
  (checking `max-entry-bytes <= max-bytes`), `--host`.

### 22. Stats endpoint
- **22a** (~6 lines) Counters: hits, misses, evictions, stale serves, upstream errors.
- **22b** (~8 lines) `GET <admin-prefix>/stats` → JSON
  `{ entries, totalBytes, hits, misses, evictions, oldestAgeMs, … }`, behind the 20a/20b
  checks.

### 23. Log hygiene
- **23a** (~5 lines) Log the path only, with query values redacted (`?key=…`). Query
  strings are where API keys live.
- **23b** (~10 lines) `--log-level` (`error|info|debug`). Per-request HIT/MISS lines move
  to `debug`.

## Phase F — Hygiene

- **24a** (~2 lines) Move `typescript`, `@types/node` to `devDependencies`.
- **24b** (~2 lines) Add a `typecheck` script (`tsc --noEmit`). Right now the test run
  (`tsx`) skips type checking.
- **24c** (~6 lines, optional) Answer HEAD from a cached GET entry (headers only).
- **24d** (~4 lines, optional) Strip headers named in the upstream `Connection` header
  (RFC 9110 §7.6.1), not just the fixed hop-by-hop set.
- **24e** (~4 lines) `X-Forwarded-For` (append), `X-Forwarded-Proto` and `Via`. Moved from
  Phase C (item 14): doesn't fix a listed bug, no reason to gate the header-forwarding
  critical path on it.

---

## Open decisions

**D1 — Header forwarding: allowlist (recommended) vs blocklist**
- *Security:* allowlist wins. With a blocklist, every header the cache key ignores
  (`X-Forwarded-Host`, `X-Original-URL`, …) can change the origin's response and poison
  the shared cache for everyone. An allowlist makes that opt-in.
- *Maintainability:* blocklist is less code and doesn't need touching per header.
  Allowlist needs an entry for each new header a user relies on.
- *DX:* blocklist "just works". With an allowlist, a missing header is a silent failure,
  so log dropped header names at `debug`.
- *Cost:* $0 either way.
- *Outside the stack:* Varnish and nginx use a blocklist and rely on configured cache
  keys. That's workable only because their keys are configurable, and ours aren't.
- **Decided by: security.**

**D2 — Admin auth: `Host` check only vs `Host` + token (recommended once `--host` exists)**
- *Security:* the `Host` check (20a) closes DNS rebinding, which is the real threat on
  loopback. A token only matters once `--host 0.0.0.0` exists (21d); on loopback it
  doesn't add real protection.
- *DX:* the token adds a secret to pass to `--clear-cache`. An env var keeps that cheap.
- *Alternative:* serving admin on a unix socket gives OS-level permissions with no token,
  but it's harder to test and doesn't work for Windows users.
- Recommendation: ship 20a now. Ship 20b in the same change as 21d (`--host`), not before.
- **Decided by: security relative to maintainability.**

**D3 — `X-Cache` for coalesced followers: `HIT` vs `MISS` vs `HIT-COALESCED`**
- `HIT-COALESCED` is honest, and it helps debugging (it shows the cache is protecting the
  origin). It breaks nothing that checks with `startsWith("HIT")`, and costs one string.
- **Recommended: `HIT-COALESCED`. Decided by: DX (debuggability).**

## Out of scope

- **Disk/Redis persistence.** Ruled out on purpose: `--clear-cache` works because the
  cache lives in the same process the CLI calls over HTTP. A restart clearing the cache is
  correct behaviour.
- **Caching non-GET methods.** Invalidation for writes is a much larger job, and a stale
  cached write is a data-integrity bug.
- **TLS termination / deployment.** Origin-side HTTPS already works through `fetch`.
- **Caching compressed bytes keyed on `Vary: Accept-Encoding`** (what nginx and Varnish
  do). Would fit roughly 4–6× more JSON into the byte budget, but it's a rewrite of the
  fetch layer. Revisit after Phase C.

## Sequencing

1. **Phase A** (1–6): any order, each on its own. Do these first.
2. **Phase B** (7–10): after A. Do 7 (config plumbing) first — 8b and every later flag
   depend on it. Item 9 before 17.
3. **Phase C**: chunk 1 (11 → 12 → 13 → 14, strictly in that order) lands as one commit.
   Chunk 2 (15–16) lands as a second commit, after chunk 1.
4. **Phase D**: 17 needs 9. 18 needs 14a. 19 needs 16a.
5. **Phase E**: 20b together with 21d (`--host`). 22 after 20a.
6. **Phase F**: any time.

Each step ships with its test in the same commit, not saved up for the end, so the
regression test exists before the next step builds on it.
