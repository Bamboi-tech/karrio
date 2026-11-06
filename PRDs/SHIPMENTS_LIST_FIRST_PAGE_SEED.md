# Shipments List: First Page With the Page

**Status:** Implemented (Bamboi fork), branch `perf/CU-1248uf454gz-shipments-seed` · **Scope:** `apps/dashboard`, `packages/core`, `packages/hooks`, `packages/lib`, `packages/types`, `packages/ui` · **Date:** 2026-11-06

---

## Executive Summary

On a full load of `/shipments` the rows became visible at ~4.1 s (production, signed in, 6 Nov 2026): HTML at 0.2 s, JS ready at 1.3 s, then six API requests at once, among which the list query took 1.8–2.8 s instead of the 0.4 s it takes alone, because the API has two CPU-bound workers. This change fetches the first page and the badge counts on the server and streams them into the first HTML response, so no client round trip is spent on either. The stacked branch `perf/CU-1248uf454gz-shipments-prefetch` (PRD `SHIPMENTS_LIST_PREFETCH.md`) warms the react-query cache before an in-app navigation; `perf/CU-1248uf454gz-shipments-burst` flattens the remaining requests.

### Key Architecture Decisions

1. **The server page streams the list instead of awaiting it.** `packages/core/modules/Shipments/page.tsx` (server) starts `loadShipmentsList` and `loadShipmentBadgeCounts` in parallel, bounded by a 3 s deadline, and hands the two promises to the client module without awaiting them. The client board resolves them with React `use()` inside a Suspense boundary whose fallback is the route's skeleton. The page segment therefore never blocks: the shell (sidebar, navbar, skeleton) is flushed at once and the board with its rows follows in the same response as soon as the API answers. A failed or timed-out fetch resolves to `null`, and the board fetches exactly as before.
2. **Only document requests carry a seed.** The page checks `Sec-Fetch-Dest: document` (Fetch Metadata, set by the browser, impossible to forge from `fetch()`) and sends `seed: null` on RSC requests. Reason: the stacked prefetch PR warms the cache on hover/focus of the sidebar link and when the home is idle, so on an in-app navigation the client already has (or is already fetching) the page; a server fetch at that point would be a second identical query on an API whose bottleneck is concurrency, and nothing would consume it. In-app navigation thus keeps today's path (board mounts, react-query serves cache or fetches). Next hides its own `RSC` header from `headers()` on purpose; the Fetch Metadata header is a web standard and survives the Caddy proxy. Browsers without it (Safari < 16.4) and plain `curl` get no seed and behave as before.
3. **One filter function for both sides.** `packages/lib/shipment-list.ts` holds `parseShipmentFilter` (moved from the hook), `shipmentListDefaults`, `shipmentListFilter` and `shipmentQueryFilter` (the sentinel-stripping and `warehouse_view` mapping that was inside the hook's fetch). The server page and `useShipments` both key on `shipmentListFilter(searchParams, view)`, and `shipmentsQuery` / `shipmentBadgeCountsQuery` are the one definition of key and fetch; the hook accepts the seed only when `hashQueryKey` of the seed's filter equals its own and the cache scope (org, test mode) matches, so drift fails safe (client fetch), never wrong rows.
4. **A cookie mirrors how this browser shows the list.** `karrio_shipment_list` carries the column, density and sort preferences (localStorage stays the source of truth), the page size and the browser's IANA time zone, tagged with a hash of user/org/mode so another user's cookie yields defaults. The server renders from it; after mount the board reads the stores once and applies at most one filter update when the mirror lagged (first visit, or a change made elsewhere). A user with a saved sort or page size therefore gets the server-fetched page for that sort, not a default page followed by a second fetch.
5. **Deterministic timestamps.** `formatDateTime(value, timeZone)` formats with `Intl.DateTimeFormat` parts in the cookie's zone on both sides (same text as the moment format). Without a zone in the cookie the server does not seed the list at all, rather than render times the browser would have to correct; the cookie is written on the first visit, so only that visit loads the old way.
6. **One seed fetch for every server page.** `fetchServerSeed` in `packages/core/context/main.ts` (token, 3 s deadline, null on any failure) now also backs the home's `loadSystemUsage`, which had its own copy of the same axios call.
7. **The next page waits for idle.** `preloadNextPage` stays, but runs through `onIdle` and never while `isPreviousData`, so a page that came with the HTML does not put its successor into the burst hydration starts.

### Scope

| In Scope | Out of Scope |
|----------|--------------|
| Server seed of the first page and badge counts on document loads | Flattening the other requests on load (PR B, `perf/CU-1248uf454gz-shipments-burst`) |
| Shared filter and view cookie | Per-row address review requests (PR B) |
| Idle-deferred next-page preload | Home idle prefetch and sidebar hover/focus prefetch (stacked PR) |
| | Changing the API or the ERP relay; splitting the 2000-line board so only the table suspends |

---

## Problem Statement

```
browser GET /shipments            → HTML (header, cards, table skeleton)        0.2 s
  ↓ JS                                                                         1.3 s
  ↓ references ‖ GetUser ‖ user_connections ‖ system_connections ‖ features
    ‖ shipment_badge_counts ‖ get_shipments_list   (2 API workers)       1.8–2.8 s
  → rows                                                                       ~4.1 s
  ↓ next page preload, address reviews
```

Desired:

```
browser GET /shipments            → shell + skeleton (first flush)             0.2 s
                                    page: get_shipments_list ‖ badge_counts    +0.4 s
  ↓ board with rows streamed into the same response
  ↓ JS, hydrate: react-query seeded, no list or badge request
  ↓ idle: next page preload
```

---

## Technical Design

### Existing Code Analysis

| Studied | Reused |
|---|---|
| `PRDs/DASHBOARD_HOME_PERFORMANCE.md`, `packages/core/modules/Dashboard/page.tsx`, `loadSystemUsage` | same loader shape (token, deadline, null on failure), `requestSession`, `loadRequestMetadata` |
| `packages/hooks/usage.ts` | `initialData` + `initialDataUpdatedAt` for exactly one key |
| `packages/hooks/shipment.ts` `parseFilter`, fetch sentinel stripping | moved to `@karrio/lib/shipment-list` |
| `packages/hooks/karrio.tsx` `scopeQueryKey`, `useQueryScope` | the seed carries the scope it was fetched for |
| `packages/core/modules/Shipments/shipment.tsx` | `React.use()` already in use in this repo (Next's vendored React 19) |
| `apps/dashboard/src/app/(base)/(dashboard)/loading.tsx` | the board's Suspense fallback draws the same skeleton |

### Sequence (document request)

```
page.tsx (server)                              index.tsx (client, SSR then hydrate)
  requestSession ‖ cookies ‖ headers ‖ params
  view   = parseShipmentListView(cookie)
  filter = shipmentListFilter(params, view)
  seed.list   = loadShipmentsList(filter)   ──┐  (not awaited)
  seed.badges = loadShipmentBadgeCounts()   ──┤
  <ShipmentsPage seed view/>                  │
                                              ▼
                                   <Suspense fallback=skeleton>
                                     ShipmentsBoard: use(seed.list), use(seed.badges)
                                     useShipments({...defaults(view), initial})   → initialData
                                     useShipmentBadgeCounts(initial)              → initialData
                                     effect: read localStorage, reconcile once, write cookie
```

### Why streaming and not `await`

With `loading.tsx` in place, awaiting in the page would stream the same shell; the difference is on the segment: an awaited page blocks every RSC render of it, including ones a future caller may make on navigation, while a passed promise never does. `use()` is the mechanism React and Next document for this, and the repo already uses it. The hydration-detection variant (consume the promise through the query function on client mounts) was dropped together with seeding on RSC requests: see decision 2.

### Cookie

`karrio_shipment_list` = URL-encoded JSON `{ scope, columns, hidden, density, sort, first, timeZone }`, `path=/`, one year, `SameSite=Lax`. `scope` is an FNV-1a hash of `email:org:mode`; no personal data travels in it.

---

## Implementation

| File | Change |
|---|---|
| `packages/lib/shipment-list.ts` | new: `parseShipmentFilter`, `initialShipmentFilter`, `shipmentQueryFilter`, `isFailedShipmentsView`, `ALL_STATUSES`, page sizes, `ShipmentListView`, cookie parse/write, `shipmentListScope`, `shipmentListDefaults`, `shipmentListFilter` |
| `packages/lib/helper.ts` | `formatDateTime(value, timeZone?)`, `onIdle` |
| `packages/types/base.ts`, `packages/types/graphql/types.ts` | `ServerSeed`, `ShipmentsPageSeed`, `shipment_badge_counts` (hand-written in the generated style) |
| `packages/core/context/main.ts` | `fetchServerSeed` (also used by `loadSystemUsage`), `loadShipmentsList`, `loadShipmentBadgeCounts` |
| `packages/core/modules/Shipments/page.tsx` | new server entry; `index.tsx` takes `seed` and `view`, suspends on the seed, renders from the view, reconciles and mirrors it |
| `apps/dashboard/src/app/(base)/**/(dashboard)/shipments/page.tsx` (4 routes) | export the server entry |
| `packages/hooks/shipment.ts` | `shipmentsQuery`, `shipmentBadgeCountsQuery` (one key + fetch each), `initial` seeds, idle next-page preload |
| `packages/hooks/shipment-list-preferences.ts` | `useShipmentListScope`; `initial` preferences for the first render |

Size: 886 changed lines, of which 120 are `parseFilter` moving verbatim from the hook to `@karrio/lib` (the discipline's module-move exception); the prefetch is its own stacked PR.

---

## Testing Strategy

- `npx tsc --noEmit -p apps/dashboard/tsconfig.json` and `npm run build -w @karrio/dashboard`.
- Signed-in `curl -H 'sec-fetch-dest: document'` with the session cookie and a view cookie: the HTML of `/shipments`, of a filtered deep link and of `/test/shipments` contains the rows (or the empty state) and the badge counts.
- Browser: no hydration warning; no `get_shipments_list` or `shipment_badge_counts` request on first load; a saved sort gives one server fetch for that sort and no second fetch; the Failed card loads no list page.

Verified 2026-11-06 against a local API with 67 shipments: `curl` HTML of `/shipments` holds 20 rows, the badge counts and Amsterdam-zoned timestamps (TTFB 58 ms, full response 128 ms); the Today deep link holds its 9 rows; `?status=_failed_creation` holds no rows; `/test/shipments` renders from the session's mode like the client does. In the browser pane a document load of `/shipments` fires no list or badge request (only `token`, the two connection queries and, after idle, page two), the console shows no hydration error, and a saved "oldest first" sort renders in that order from the HTML with no second list fetch. Not verified: production latency numbers; Safari; a browser whose clock is far off the API's.

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Rows rendered on the server for the first time: a row component that touches `window` would break SSR | verified by rendering the real list (20 rows, popovers, menus); React would fall back to client rendering of the boundary, not crash |
| React 19.2+ batches boundary reveals (`$RC` → `$RV`, next animation frame): in a background tab the streamed rows wait for a frame | observed only with the browser pane hidden; a visible tab reveals on the next frame |
| Amsterdam midnight between server render and hydration (`cardStatus`, overdue marker) | a two-second window per day; React re-renders the boundary on mismatch |
| Clock skew between API host and browser makes the seed look stale or fresh | both directions are benign: an extra background refetch, or a seed trusted ≤ 5 s longer |
| A proxy strips `Sec-Fetch-Dest` | no seed: the old behaviour |
| Cookie size (~450 bytes on every dashboard request) | bounded; far below the 4 KB limit |

## Migration & Rollback

No schema or data migration. First visit per browser writes the cookie and loads the old way once. Rollback is a redeploy of the previous image tag.
