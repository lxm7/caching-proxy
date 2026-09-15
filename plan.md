# Cache Proxy — Plan

Living doc, derived from `docs/requirements.md`. Will edit as we go; I'll flag when I do.

## Environment (confirmed)

- Node: v22.23.2 (installed)
- `@types/node`: `^22.x` — latest patch `22.20.2`, matches installed Node major
- TypeScript: requested "6" — see open decision below, npm has since shipped 7.x

## Build order

1. **Scaffold** — `package.json`, `tsconfig.json` (strict), `.gitignore`, install deps
2. **CLI entry + arg parsing** — `--port <number>`, `--origin <url>`, `--clear-cache`
3. **Cache store** — key by request (method + URL, at minimum), value = `{ status, headers, body }`. Storage mechanism: open decision below
4. **Proxy handler** — on request: cache hit → replay response + `X-Cache: HIT`; cache miss → forward to origin, store response, return + `X-Cache: MISS`
5. **`--clear-cache`** — wipe the cache store
6. **Manual verification** — run proxy against a real origin (e.g. `http://dummyjson.com`), curl twice, confirm HIT/MISS behavior and clear-cache
7. **Stretch (not in requirements)** — lint/tests if time allows

## Decisions

- **TypeScript version** — pinned `6.0.3` (last true v6; npm `latest` has since moved to `7.0.2`, not using it).
- **Cache persistence** — disk-backed. `--clear-cache` acts directly on the same on-disk store the proxy reads/writes during request interception — no admin HTTP endpoint, no in-memory-only cache. Format (JSON file vs. sqlite) still open, see below.

## Open decisions

- **Cache storage format** — plain JSON file vs. sqlite (via `better-sqlite3`)?
- **CLI parsing** — hand-rolled `process.argv` parsing vs. a library (`commander`/`yargs`) vs. Node's built-in `util.parseArgs`?
- **HTTP forwarding** — native `fetch` (Node 22 has it) vs. `http`/`https` module for raw header/stream passthrough fidelity?

## Status

Not started — plan only, no code written yet.
