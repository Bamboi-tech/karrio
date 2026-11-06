# References: Stale-While-Revalidate Cache

| Field | Value |
|-------|-------|
| Project | Karrio (Bamboi fork) |
| Date | 2026-11-06 |
| Status | Implemented, pending review |
| Type | Performance |
| Task | CU-1248uf454gz |

## Problem

Every full page load of the dashboard fetched `GET /v1/references?reduced=true`
from the API on the page's critical path: 302 KB of JSON (52 KB zstd), 0.3 to
0.6 s when the API was idle, 1.2 s inside the page-load burst, with a user RTT
of ~150 ms and two CPU-bound gunicorn workers shared with the queries the page
actually waits for. The response carried an `ETag` but no `Cache-Control`.

## Evidence (6 November 2026)

Production, measured with `curl` on a reused HTTP/2 connection:

| Request | TTFB | Bytes |
|---|---|---|
| `GET /` (metadata, baseline) | 0.149 s | 651 |
| `GET /v1/references?reduced=true`, warm | 0.175 to 0.187 s | 52 615 (zstd) |
| same, first on a connection or random slow call | 0.46 to 0.57 s | 52 615 |
| same with `If-None-Match` + `Accept-Encoding: zstd` | 0.149 to 0.219 s | 0 (304) |
| preflight `OPTIONS` | allowed headers did not include `if-none-match`; `ETag` not exposed | |

Server, `origin/main` in-process (Django test client, Redis cache, warm):

| Path | Median |
|---|---|
| 200 reduced | 5.5 ms |
| 304 reduced | 3.0 ms (1.4 ms of it: fetching and unpickling the 260 KB dict only to read its ETag) |
| 200 full | 7.8 ms |
| `GET /` baseline | 1.5 ms |
| cold rebuild of the payload (cache miss) | 15 to 25 ms |

Findings:

1. The view already cached the translated payload (5 min TTL, version counter
   bumped by constance and carrier-connection signals) and answered
   `If-None-Match` with a 304 and zero queries. It did not recompute per request.
2. The slow cold call is not the payload: the first request on every freshly
   forked gunicorn worker pays the lazy URLconf import (0.86 s locally, GraphQL
   schema included) because `preload_app` only imports the WSGI module. With
   `max_requests=1000` the two workers recycle regularly. Separate PR:
   resolve the URLconf in `when_ready` before forking.
3. The payload is not user-scoped at runtime: the view runs with
   `authentication_classes([])` (upstream), so DRF resets `request.user` to
   `AnonymousUser` before `contextual_reference` runs; `custom_carriers` is
   always `{}`. The payload depends on origin, language, `reduced` and test
   mode only. The stored copy therefore holds no user data; a test pins this.
4. Caddy appends `-zstd` to the ETag and strips it again from
   `If-None-Match` when the same encoding is negotiated (verified: 304 on
   production). A mismatch degrades to a 200, never to a wrong answer.
5. The dashboard origin differs from the API origin: sending `If-None-Match`
   from script needs it in `Access-Control-Allow-Headers`, reading the ETag
   needs `Access-Control-Expose-Headers`.

## Design

```
 browser                                   API (Django)                Redis
 ───────────────────────────────           ─────────────────────────   ──────────────
 hydrate  ──► read localStorage slot ──►  (no network)
          seed react-query (0 ms)
          page renders with references
          page's own queries settle,
          browser idle
          ──► GET /v1/references
              If-None-Match: "etag"  ──►  key = scope(origin, lang,
                                          reduced, test_mode, version,
                                          counter)
                                          GET key:etag ─────────────► 0.1 ms
                                          match → 304, no body
                                          miss  → GET key (bytes) ──► 0.2 ms
                                                  → 200 pre-serialized
          304 → keep same object (no re-render)
          200 → setQueryData + write slot when idle
```

Server (`modules/core/karrio/server/core/views/references.py`):

| Change | Why |
|---|---|
| Entry stores the pre-serialized body plus a separate `<key>:etag` entry (`set_many`, same TTL) | A revalidation reads ~40 bytes instead of a 260 KB pickle; a 200 skips the JSON render |
| Key prefix `references:v2` and `settings.VERSION` in the key | Old-shape entries from a previous deploy are never read; a version bump starts clean |
| `Cache-Control: private, no-cache` on 200 and 304 | Explicit semantics: only the browser may store it, and it must revalidate |
| `CORS_ALLOW_HEADERS += if-none-match`, `CORS_EXPOSE_HEADERS = [ETag]` | The cross-origin dashboard can send and read the validator |

Invalidation is unchanged: constance `config_updated` and carrier connection
`post_save`/`post_delete` bump the version counter; the 5 min TTL bounds
everything without a signal (rate-sheet services of custom carriers, tenant
flags, same-version deploys). Entries are keyed by scope, so no scope can
read another's copy.

Client (`packages/lib/references-cache.ts`, `packages/hooks/api-metadata.tsx`):

| Rule | Implementation |
|---|---|
| Hydration-safe | Storage is read in `useEffect`; the query stays disabled until that check, so server and first client render agree |
| Seed | `queryClient.setQueryData(scopedKey, entry.data)`; consumers have references with no round trip |
| Revalidate once per page load | `whenQuiet`: after `queryClient.isFetching() === 0` (max 5 s) and `requestIdleCallback`, the query is invalidated and enabled; it sends `If-None-Match`; a 304 returns the same entry object |
| Scope | Slot `karrio:references:v1:<user|anon>:<reduced|full>` (4 entries max); the entry carries a scope id of host, API version, user, org, test mode, auth and variant; any mismatch drops it |
| Sign-out | The signed-in slots are purged whenever the session status is `unauthenticated` |
| Degrade | Every storage access is in `try/catch`; a conditional request that fails before a response (old API, proxy) is retried once plainly; without an exposed ETag the copy is kept and revalidated with a plain GET |

Alternative considered: rely on the browser HTTP cache (`Cache-Control:
private, no-cache` + ETag, no CORS change). Rejected: the page would still wait
for a round trip, a 304 hands the script the full cached body to parse, the
cache can be evicted or disabled, and a second copy of the payload would live
next to the stored one.

## Verified

- `karrio test karrio.server.core.tests.test_references_cache karrio.server.core.tests.test_references_i18n`: 30 tests OK (built once, 304 reads only the validator with 0 queries, setting and connection changes invalidate, scopes do not share a validator, caller-independence, CORS).
- `vitest run tests/references-cache.test.ts` in `packages/ui`: 10 tests OK (storage round trip, scope mismatch, corrupt or throwing storage, 304/200/retry paths, settle-then-idle).
- In-process after the change: 200 reduced 5.5 → 1.95 ms, 304 3.0 → 1.8 ms, 200 full 7.8 → 2.0 ms. Through gunicorn on localhost: 200 6.5 → 3.3 ms, 304 → 2.4 ms, 0 bytes.
- Local API (gunicorn, Redis) returns `ETag`, `Cache-Control: private, no-cache`, `Access-Control-Expose-Headers: ETag`, and the preflight allows `if-none-match`.
- `tsc --noEmit` for the dashboard: clean. Browser verification: see the PR.

## Not verified

- Production Caddy with a browser that negotiates `gzip` after `zstd` (or the
  reverse): the stored ETag then carries the other suffix and the revalidation
  costs one 200 instead of a 304.
- Safari (no `requestIdleCallback`: the `setTimeout(50)` fallback runs) and
  private mode were not exercised in a browser.
- The worker cold-start fix is out of scope and not implemented.
