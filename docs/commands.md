# Validation commands

Commands used to verify `src/index.ts` behaves as intended.

## Confirm 200 response with body "ok"

```sh
curl -s -i http://127.0.0.1:3000/anything
```

Expected: `HTTP/1.1 200 OK` and body `ok`, regardless of path — confirms every
request is answered the same way.

## Free port 3000 if a previous run was left listening

```sh
lsof -ti:3000 | xargs -r kill
```
