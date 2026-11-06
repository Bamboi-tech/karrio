# Shipments List API Cost

**Status:** Implemented (Bamboi fork), ClickUp CU-1248uf454gz · **Scope:** `modules/graph`, `modules/manager`, `modules/core` (filters) · **Date:** 2026-11-06

---

## Problem

The dashboard's `/shipments` page fires `get_shipments_list` (first: 20, nine statuses) and `shipment_badge_counts` on every visit. Measured from a client with ~150 ms RTT on production (6 Nov 2026): the list ~400 ms (~250 ms server), the badge counts ~225 ms, a trivial query ~180–225 ms; six parallel requests push the list to 1.8–2.8 s on the 2-vCPU VM. The database is small (a few thousand shipments, 200 MB, 99.9 % cache hit), so the question was what the API does per request.

What the code did, read from the SQL a test captures (`test_shipments_list_cost.py`):

1. **`SELECT DISTINCT` over every column.** django-filter's `MultipleChoiceFilter` adds `.distinct()` by default, so the `status` filter turned the page SELECT and the COUNT into `DISTINCT` over all 40 columns of the row plus the four joined tables, `label` and `invoice` (base64 documents) included. The count became `COUNT(*) FROM (SELECT DISTINCT ...)`: a sort of every matching row.
2. **Documents and tracker payloads loaded for a listing.** The list shows `label_url`/`invoice_url` (a URL built from the id) and `tracker_id`, but every row carried the label (tens of KB of base64), the invoice and, through `select_related("shipment_tracker")`, the tracker's events, messages and signature/delivery images.
3. **Count badges fetched rows.** `paginated_connection` sliced the queryset eagerly, so each of the three `page_info { count }` aliases also ran a full-row page SELECT it never used: six statements for three numbers.
4. **Parse and validation on every request.** Strawberry parsed and validated the 100-line document each time (~4 ms of CPU per list request, paid before any resolver ran).

Not found: no N+1 (the row count does not change the statement count), no eager total (already lazy since the September audit), no per-request SQL for auth, constance or middleware (the JWT user comes from the cache; a `{ __typename }` request runs zero statements).

## Design

| Change | Where | Effect |
|---|---|---|
| `status` filter: `distinct=False` | `core/filters.py` `ShipmentFilters` | A column of the row cannot duplicate rows; the page SELECT and the COUNT lose `DISTINCT` (and the subquery). The REST list shares the filter and gains the same. |
| `Shipment.for_listing(queryset, with_tracker)` | `manager/models.py` | `defer("label", "invoice")` with `_has_label`/`_has_invoice` annotations; `label_url`/`invoice_url` read the annotation through `has_document()` and fall back to the column when no annotation is present (REST, detail). The tracker's `events`, `messages`, `delivery_image`, `signature_image` are deferred unless the query selects `tracker`. |
| `utils.selects(info, *path)` | `graph/utils.py` | Reads the selection set under the resolved field, through fragment spreads and inline fragments, so the tracker deferral is driven by what the client asked for. |
| Lazy `Page` behind `Connection` | `graph/utils.py` | `paginated_connection` no longer touches the database; the page SELECT runs when `edges` or a cursor is resolved, the COUNT when `count` is. Cursor and `has_next_page` semantics are unchanged (same `first + 1` fetch, same `edges[-2]` end cursor). SDL is byte-identical (checked with `schema.as_str()`). |
| `ParserCache` + `ValidationCache` (256 entries each) | `graph/schema.py` | Parse and validation results are reused per process for repeated operation texts. |

Index: none. At 20k synthetic rows on `postgres:16` the page SELECT walks `shipment_created_at_idx` backward and stops after 21 rows (0.13 ms); the list COUNT is a sequential scan because the nine statuses match 99 % of rows (20 ms at 20k rows, ~4 ms at production size); the badge counts use the existing status index (0.7–1.5 ms). Two candidate btrees (`(status, created_at DESC)`, partial `created_at` for drafts) changed nothing or ≤ 0.3 ms. A covering `(status) INCLUDE (is_archived, test_mode)` turns the COUNT into an index-only scan (20 → 3.5 ms at 20k rows) but needs a fresh visibility map and saves ~3 ms at today's size: worth a migration only if the table grows past ~20k rows or the COUNT shows up in `pg_stat_statements`.

## Measurements

Same fixtures (40 shipments with parcels, items, three rates, selected rate, carrier snapshot, 40 KB label, tracker with 12 events for the tracked statuses), same JWT-authenticated request through the Django test client. `SHIPMENTS_LIST_PROFILE=1 karrio test karrio.server.graph.tests.test_shipments_list_cost` reproduces the table (min of 60 requests).

| Request | SQL statements before → after | SQLite wall ms before → after | Postgres 16 wall ms before → after | Postgres CPU ms before → after |
|---|---|---|---|---|
| list first: 20 (62 838 B) | 2 → 2 | 23.0 → 20.1 | 33.1 → 24.5 | 23.4 → 19.7 |
| list first: 5 (16 656 B) | 2 → 2 | 14.0 → 9.4 | 19.5 → 11.1 | 12.8 → 8.8 |
| badge counts (124 B) | 6 → 3 | 10.7 → 7.0 | 23.6 → 10.8 | 12.7 → 7.2 |
| GetUser (227 B) | 3 → 3 | 1.7 → 1.3 | 3.4 → 3.5 | 2.2 → 1.5 |
| `{ __typename }` | 0 → 0 | — → 0.6 | — | — |

Postgres at 20k rows, the list queries alone (EXPLAIN ANALYZE, fetched from Python): page SELECT 13.7 → 3.1 ms, COUNT 42 → 20 ms (DISTINCT sort gone), badge page SELECTs 6–15 ms each → not run.

Where the remaining list time goes (cProfile, 20 rows): ~70 % graphql-core/strawberry field completion over the 1 632 fields the query selects, ~10 % Django row materialisation and JSON column decoding, ~5 % django-filter form construction, 4 % auth. None of it is per-row work of our own: `RateType.parse`, `ParcelType.parse` and `label_url` together are under 1 ms.

Per-request fixed cost (`{ __typename }`, 0.6 ms locally): `authenticate_user` 0.36 ms, of which 0.25 ms is `OAuth2Authentication` trying the Bearer JWT (jwcrypto parse, oauthlib request deep-copies) before `JWTAuthentication` gets it; `save_tracing_records` 0.1 ms spawning a `ThreadPoolExecutor` per request to find an empty record list; strawberry execution 0.15 ms. The production figure for a trivial query (180–225 ms with 150 ms RTT) is therefore not API Python; it is the network path (TLS, proxy, keep-alive) and should be measured from the VM.

## Verified

- `karrio test karrio.server.graph.tests karrio.server.manager.tests karrio.server.orders.tests karrio.server.events.tests karrio.server.core.tests`: 535 tests OK on SQLite; the new module also passes against a throwaway `postgres:16`.
- The list and badge responses are byte-identical before and after for the same fixtures (sha256 of the response bodies), and `test_list_returns_the_dashboard_rows` pins the full 20-row response.
- `test_query_text_matches_the_dashboard` fails when `packages/types/graphql/queries.ts` drifts from the copies in the test.
- Selecting `tracker { ... }` on the list keeps one statement (no per-row reload); `is_archived: true` (plain manager, no select_related) accepts the same trimming.

## Not Verified

- Production timings after deploy; the local gain is 25–45 % per request and the burst behaviour (CPU contention on 2 vCPUs) scales with it but was not reproduced.
- The REST `/v1/shipments` list only through the existing manager tests (it loses `DISTINCT` too).
- Label sizes in production (fixtures assume 40 KB base64; real DHL/Monta labels may be larger, which makes the deferral worth more).

## Proposed separately

1. `AUTHENTICATION_CLASSES` order: try `JWTAuthentication` before `OAuth2Authentication` (settings; touches auth order, needs its own review).
2. `tracing/utils.py` `save_tracing_records`: return before `run_async` when `tracer.records` is empty (one thread spawn per request).
3. Covering index for the list COUNT, when the table size justifies it (above).
