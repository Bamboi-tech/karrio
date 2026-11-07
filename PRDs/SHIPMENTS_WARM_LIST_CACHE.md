# Shipments List: Warm Response Cache

**Status:** Implemented (Bamboi fork), branch `perf/CU-1248uf454gz-warm-list-cache` · **Scope:** `modules/graph`, `modules/core`, `modules/manager` (signals), `modules/events`, `modules/orders` (two bump calls), `apps/api` settings, `ansible/vars` · **Date:** 2026-11-06

---

## Problem

One or two warehouse operators use the shipments board all day, and it has to feel instant for them. After `SHIPMENTS_LIST_API_COST.md` the list request still costs ~20 ms of API CPU on a 2-vCPU VM shared with everything else, of which ~70 % is graphql-core/Strawberry completing the 1 600 fields the query selects; the first-page seed (`SHIPMENTS_LIST_FIRST_PAGE_SEED.md`) moved that work to the HTML response but did not remove it. The two operations the board sends, `get_shipments_list` and `shipment_badge_counts`, are the same text with the same few variable sets every time, and the data they read changes a few hundred times a day. That is a response cache's shape: compute once per change, in the background, and answer every request from the stored bytes.

## Design

```
request ──► AccessMixin (auth) ──► GraphQLView.run
                                     │ warm_cache.request_entry(request)
                                     │   designated user? JSON POST? "query get_shipments_list|shipment_badge_counts"?
                                     ├─ no ──► Strawberry as before
                                     └─ yes ─► cache.get_many([version, body_key])
                                                 ├─ body tagged with the current version ──► HttpResponse(bytes)   (hit)
                                                 └─ otherwise ──► Strawberry ──► store (version read before, body)  (miss)

Shipment / Tracking row written ──► post_save / post_delete ──► core.warm_cache.data_changed()
bulk_save_trackers, _retire_aged_out_trackers, orders.signals .update() ──► data_changed() explicitly
  └─ transaction.on_commit ──► cache.incr(version) ──► signal shipments_changed
        └─ graph.warm_cache.schedule: cache.add(pending) ──► huey warm_shipments_lists, +2 s
              └─ lock; delete pending; version = current; for each remembered scope,
                 for each of its recent operation sets whose body is not at version:
                   execute as that user (no HTTP), store (version, body)
huey warm_shipments_lists_periodic (*/5 min): the same, catches a restart or an eviction
```

| Piece | Where | What |
|---|---|---|
| Setting | `settings/base.py` `SHIPMENTS_WARM_USERS` | comma-separated emails, lower-cased; empty = feature off, no key is ever written |
| Shared state | `core/warm_cache.py` | `is_warm_user`, `data_version` (counter in the Django cache, initialised to the epoch second), `data_changed` (on-commit `incr` + `shipments_changed` signal) |
| Response cache | `graph/warm_cache.py` | `request_entry` / `lookup` / `store` for the view; `warm` / `warm_scope` / `render` for the worker; `schedule` receiver |
| View hook | `graph/views.py` `GraphQLView.run` | lookup before `super().run`, store after; `process_result` flags results with errors so they are never stored |
| Tasks | `graph/tasks.py` | `warm_shipments_lists` (db_task, huey lock), `warm_shipments_lists_periodic` (every 5 min); autodiscovered by `run_huey` |
| Model signals | `manager/signals.py` | `post_save` and `post_delete` of `Shipment` and `Tracking` → `data_changed` |
| Bulk paths | `manager/serializers/tracking.py`, `events/.../tracking.py`, `orders/signals.py` | `bulk_update` and `queryset.update` fire no signal: one explicit call each |
| Worker cache | `settings/cache.py` | the worker now shares the Redis cache instead of an in-process LocMem (below) |

**Hook.** The Strawberry Django view's `run()` is the one method that parses the body, executes and builds the `HttpResponse`; overriding it in the existing `GraphQLView` subclass lets a hit return bytes without touching Strawberry, graphql-core or the resolvers, and a miss go through the unchanged pipeline. `execute_operation` would still pay `process_result` and `encode_json` on a hit; a middleware would run before authentication. Nothing in graphql-core or Strawberry is patched.

**Key.** `shipments_warm:body:<user pk>:<org pk>:<test mode>:<sha256(name, query, variables)[:32]>`, value `(version, bytes)`. Keeping the version in the value rather than the key means one `get_many` on a hit and no accumulation of old versions: the warmer overwrites the same key. Scope and operation sets are remembered in `shipments_warm:recent:<scope>` (last 8, most recent first, one-day TTL that every warm run touches) and `shipments_warm:scopes`.

**Eligibility.** Designated user, JSON `POST`, and a document that starts with `query <allowed name>` (regex, no parse): a mutation named like the query, an anonymous document or a multi-operation document never enters the cache. An explicit `operationName` must agree. The warmer additionally executes with `allowed_operation_types={QUERY}`. Results with errors are not stored; a hit carries only the JSON body and `Content-Type`; cookies and `X-org-id`/`X-test-mode` come from `AuthenticationMiddleware` on every response, hit or miss, exactly as before.

**Isolation.** User pk, org pk and test mode are in the key; the warmer resolves the user by pk, checks it is still designated and active, and builds the request context with `get_request_user` the way the HTTP path does. In this fork `KARRIO_ENTITY_ACCESS_METHOD` is `WideAccess` and orgs are off, so two designated users would compute identical bodies, but they never share one.

**Failure.** Every cache call on the request path is wrapped: a Redis error logs a warning and the request executes normally. A missing version key (fresh deploy, flush) is re-created on first use. The warmer runs in the worker; the API never waits for it.

## Invalidation model

A body is served only when the version stored with it equals the version read in the same `get_many`. Any write to a `Shipment` or `Tracking` row moves the version *after commit* (`transaction.on_commit`), so an execution that read the new version also reads committed data; an execution that read the old version and stored a newer state is harmless. The list reads only those two tables (addresses, parcels, rates, carrier are JSON columns of the shipment; `tracker_id` comes from `shipment_tracker`); orders and manifests are not selected, so they do not bump.

Signal-bypassing writes found by grep and covered explicitly: `bulk_save_trackers` (tracking pulse, `bulk_update` of trackers and shipment statuses), `_retire_aged_out_trackers` (`queryset.update`), and the orders signal that `update()`s `meta`/`order_id` inside the shipment `post_save` (an extra bump after it, so a body computed between the two writes is superseded). `data` batch `bulk_create` of trackers goes through `Tracking` rows the list does not show until a shipment links them, which is a save.

Residual: a write to these tables that neither saves a model nor calls `data_changed` (a future raw `update()`) would leave a body stale until the next change. The version counter lives in Redis without expiry; with the default `noeviction` policy it can only disappear with a flush, which drops the bodies too.

## How to configure

Production sets the emails through `ansible/vars/karrio-compose.yaml`: both `api` and `worker` read `SHIPMENTS_WARM_USERS: "{{ shipments_warm_users | default('') }}"`. The operator adds `shipments_warm_users: "a@bamboi.eu,b@bamboi.eu"` to the environment vars (`ansible/vars/production.yaml` or the vault), then deploys as usual (`update-karrio.yml`). Unset, the feature is off. Emails are never logged; the warm run logs only a count.

The worker needs the value because it moves the version (tracking pulse) and executes the warm runs; and it needs the Redis cache: `settings/cache.py` used to give the `run_huey` process a LocMem cache ("only Huey needs Redis"), which would have made the warmer write into memory the API never reads. The worker now configures the same Redis cache as the API (a handful of connections; the JWT user entries it invalidates on a user save also only existed in Redis).

`DEBOUNCE_SECONDS` (2), `RECENT_SETS` (8) and the periodic cadence (5 min) are constants in `graph/warm_cache.py` and `graph/tasks.py`. In huey immediate mode (tests, `DETACHED_WORKER` without Redis) the warm run executes inline in the request that changed the data.

## Measurements

Same fixtures as `test_shipments_list_cost` (40 shipments, 20-row page, SQLite, Django test client, JWT auth). `SHIPMENTS_LIST_PROFILE=1 karrio test karrio.server.graph.tests.test_shipments_warm_cache` reproduces it (min of 60 requests; a "miss" clears the whole cache, so it also pays the JWT user SELECT, ~0.5 ms).

| Request | Miss wall ms | Hit wall ms |
|---|---|---|
| list first: 20 (62 838 B) | 19.7 | 0.55 |
| badge counts (124 B) | 8.1 | 0.53 |
| hit path Python alone (`request_entry` + `lookup`, LocMem) | — | 0.021 |

A hit costs the fixed per-request path measured in `SHIPMENTS_LIST_API_COST.md` (`{ __typename }` 0.6 ms: auth, middleware) plus ~20 µs; on production the Redis round trip adds ~0.2 ms. Warm run cost per change burst: one execution per remembered set (≤ 8 per user, ≈ 20 ms each) in the worker, not the API.

## Verified

- `karrio test karrio.server.graph.tests karrio.server.core.tests karrio.server.manager.tests karrio.server.events.tests karrio.server.orders.tests`: 567 tests OK on SQLite (543 before this branch, plus the 8 of `test_shipments_list_cost` and these 16). `graph/tests/__init__.py` lists its modules explicitly and did not list `test_shipments_list_cost` (merged in #45), so neither it nor this module ran under the package label `bin/run-server-tests` uses; both are registered now (`test_system_usage` still is not).
- `test_shipments_warm_cache` (16 tests): miss then hit with Strawberry's `execute_sync` patched to fail; byte-identical body and cookies hit vs miss and warmer vs normal response; a saved shipment moves the version and the inline warm run makes the next request a fresh hit; without the warmer the next request is a miss that sees the change; `bulk_save_trackers` moves the version; recent sets capped at 8, most recent first; user and test-mode isolation; non-designated user and empty setting leave no key; errors not stored; `get_many` raising leaves the response intact; a mutation named like the query is neither cached nor executed by the warmer; the periodic task re-warms evicted bodies and does nothing when warm.

## Not Verified

- Against Redis and a real `run_huey` worker (the debounce, the lock re-schedule and the shared cache were reasoned, not run); production timings.
- With `MULTI_ORGANIZATIONS` on (the org branch of `request_for`).
- The dashboard's exact request shape on production (`operationName` key, `Content-Type`): checked against the queries in `packages/types/graphql/queries.ts` and `fetchServerSeed`, not against a captured request.
