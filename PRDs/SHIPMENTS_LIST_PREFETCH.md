# Shipments List: Prefetch Before Navigation

**Status:** Implemented (Bamboi fork), branch `perf/CU-1248uf454gz-shipments-prefetch`, stacked on `perf/CU-1248uf454gz-shipments-seed` · **Scope:** `packages/core`, `packages/hooks`, `packages/lib`, `packages/ui` · **Date:** 2026-11-06

---

## Executive Summary

The seed PR puts the first page of `/shipments` in the HTML of a document load and deliberately leaves in-app navigations to the react-query cache. This PR fills that cache before the operator arrives: the home page prefetches the board's default first page and badge counts once it is idle, and the Shipments link in the sidebar does the same on hover or focus. A sidebar click then shows rows at once, without a list request.

### Key Architecture Decisions

1. **One helper, the board's own key and fetch.** `usePrefetchShipmentsList` (`packages/hooks/shipment.ts`) calls `shipmentsQuery` and `shipmentBadgeCountsQuery`, the functions `useShipments` and `useShipmentBadgeCounts` build their queries from, and scopes the keys with `scopeQueryKey` exactly as `useAuthenticatedQuery` does. The default filter comes from `shipmentListFilter(null, readShipmentListCookie(scope))`: the same cookie the board's server page reads, so the prefetched key is the key the board derives on arrival. There is no second definition to drift.
2. **Idle, after the home has painted.** The home calls the helper from an effect through `onIdle` (requestIdleCallback with a 2 s deadline; a plain 2 s timeout where it is missing). It never runs before the home's own commit and never competes with its first paint.
3. **Intent on the sidebar link.** `NavMain` items take an optional `onIntent`, wired to `onMouseEnter` and `onFocus` of the link; `AppSidebar` sets it on the Shipments item. `prefetchQuery` with the list's 5 s stale time means a hover that follows a recent fetch sends nothing.

### Scope

| In Scope | Out of Scope |
|----------|--------------|
| Home idle prefetch, sidebar hover/focus prefetch | Prefetching other pages |
| `readShipmentListCookie` (client read of the view cookie) | Next's own route prefetch (the page segment is already prefetched by `Link`) |

---

## Technical Design

```
home mounts ─ commit ─ onIdle(2 s) ─► prefetchQuery(list key) ‖ prefetchQuery(badge key)
sidebar "Shipments" hover/focus ───► same helper (stale after 5 s → refetch, else nothing)
click ─► RSC navigation (no seed, see seed PRD) ─► board mounts ─► react-query cache hit → rows
```

### Existing Code Analysis

| Studied | Reused |
|---|---|
| `packages/hooks/shipment.ts` `shipmentsQuery`, `shipmentBadgeCountsQuery` | the only key + fetch definitions |
| `packages/hooks/karrio.tsx` `scopeQueryKey`, `useQueryScope` | same scoping as the board's queries |
| `packages/lib/shipment-list.ts` | `shipmentListFilter`, cookie parsing |
| `packages/ui/components/nav-main.tsx`, `app-link.tsx` | link props already pass through to `next/link` |

## Implementation

| File | Change |
|---|---|
| `packages/hooks/shipment.ts` | `usePrefetchShipmentsList` |
| `packages/lib/shipment-list.ts` | `readShipmentListCookie` |
| `packages/core/modules/Dashboard/index.tsx` | idle prefetch effect |
| `packages/ui/components/sidebar.tsx`, `nav-main.tsx`, `packages/ui/core/components/app-link.tsx` | `onIntent` on the Shipments item; `onFocus` accepted by `AppLink` |

## Testing Strategy

Browser pane, local API (67 shipments), 2026-11-06: on the home a `get_shipments_list` request goes out after the usage cards have rendered; hovering the sidebar link sends one `get_shipments_list` with the default filter 38 ms after the pointer lands (none when the cache is fresher than 5 s); after the click the rows are in the DOM 77 ms later (the RSC round trip), no skeleton is shown and no first-page request is sent. Not verified: production timings; keyboard focus on the link (same handler, not exercised).

## Risk Assessment

| Risk | Mitigation |
|---|---|
| A prefetch on every hover | 5 s stale time on `prefetchQuery` |
| Prefetched filter differs from the board's | both derive from the cookie through `shipmentListFilter`; a mismatch only means a cache miss |
| Home idle prefetch costs an API query for operators who never open the board | one list query per home visit, after idle; acceptable for the warehouse's main path |
