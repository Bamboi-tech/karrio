# Shipments List: Flatten the Request Burst

**Status:** Implemented (Bamboi fork), branch `perf/CU-1248uf454gz-shipments-burst`, stacked on `perf/CU-1248uf454gz-shipments-prefetch` · **Scope:** `packages/core`, `packages/hooks`, `packages/ui` · **Date:** 2026-11-06

---

## Executive Summary

With the first page in the HTML (seed PR), hydration of `/shipments` still started `user_connections`, `system_connections`, `/v1/erp/features` and, where `DOCUMENTS_MANAGEMENT` is on, `document_templates` the moment the board and its hundred row menus mounted, next to `references` and the sidebar's `api_token`. None of them changes what the rows look like on first paint. They now wait until the rows are on screen and the browser has been idle once, so the list query runs alone on the API's two workers when it does have to run.

### Key Architecture Decisions

1. **One page-level idle flag.** `useBrowserIdle` (`packages/hooks/browser-idle.ts`) is a `useSyncExternalStore` over a single `requestIdleCallback` (1.5 s deadline, timeout fallback) shared by every subscriber. It is false during SSR and hydration, true after the first idle moment, and stays true: a later in-app navigation mounts with nothing deferred, which is right, because the point is the first paint of the page.
2. **List first.** The board gates the connections and the feature registry on `settled = idle && (listReady || error || Failed card)`. On a document load the rows are in the HTML, so this is simply "after idle"; on a client navigation with a cold cache the list request is sent alone and the rest follows when it has answered.
3. **No wrong-then-right.** `useBamboiFeatures` already answers from `BAMBOI_FEATURE_DEFAULTS`, a verbatim copy of the ERP registry, until the fetch returns, and its values are only read by the toolbar (needs a selection) and the row menus (need a click). The connections only feed `getCarrier` for avatar colours on rows that have a rate but no `selected_rate_carrier`; ERP-created drafts have no rates and purchased rows carry `selected_rate_carrier`, so no Bamboi row changes. `document_templates` is read when a row menu opens.
4. **Row menus share the deferral.** `ShipmentMenu` passes the idle flag to `useDocumentTemplates` and `useBamboiFeatures`; both are one query each by key, so a hundred rows still make one request, now after idle.
5. **Address reviews: nothing to change.** `useAddressReview` is enabled only while `AddressReviewPopover` or `AddressEditDialog` is open (`open && linked && ...`), on `main` and on the production tag `2026.1.31-5504acf`. In the browser pane, neither a document load of the All view nor of the Needs Attention view (`status=draft,_address_review&metadata_key=address_review_required`) sent a `get-address-review` request; opening one popover sent exactly one. The seven POSTs measured on production on 6 Nov did not come from the list rendering and could not be reproduced from the code; the next measurement should record their initiator (devtools "Initiator" column) before anything is changed here.

### Scope

| In Scope | Out of Scope |
|----------|--------------|
| Deferral of connections, features, document templates on the board and its row menus | `references` and `packages/hooks/api-metadata.tsx` (owned elsewhere) |
| | `api_token` in the sidebar's team switcher: it gates the sidebar header on `isFetched`, so deferring it would lengthen the placeholder (a candidate for its own change: the header should not need the API key) |
| | Backend / ERP relay endpoints |

---

## Request order after this change

```
document load of /shipments (seeded)
  HTML: shell ‖ board with rows            (no list, no badge request)
  hydrate: references, api_token           (layout; not this PR)
  idle:    user_connections, system_connections, /v1/erp/features,
           [document_templates], next page preload
client navigation, cold cache
  mount:   get_shipments_list, shipment_badge_counts
  rows + idle: the four above
```

Measured in the browser pane (local API, 67 shipments) on the seed branch before this change: `/v1/erp/features`, `get_user_connections` and `get_system_connections` went out 1–2 ms after the board hydrated (t≈506 ms), with the page-two preload at 688 ms. After: see the verification section.

## Implementation

| File | Change |
|---|---|
| `packages/hooks/browser-idle.ts` | new: `useBrowserIdle` |
| `packages/hooks/bamboi-features.ts` | `useBamboiFeatures({ enabled })` |
| `packages/hooks/user-connection.ts`, `system-connection.ts` | `enabled` option |
| `packages/ui/components/shipment-menu.tsx` | templates and flags wait for idle |
| `packages/core/modules/Shipments/index.tsx` | `settled` gate for connections and flags |

## Testing Strategy

`npx tsc --noEmit -p apps/dashboard/tsconfig.json`, `npm run build -w @karrio/dashboard`; browser pane, local API (67 shipments), 2026-11-06:

- Document load of `/shipments`: rows in the HTML (TTFB 36 ms); `references` and `api_token` at ~90 ms; `user_connections`, `system_connections`, `/v1/erp/features` and the page-two preload together at the first idle moment (585–590 ms), nothing between hydration and idle. No hydration error in the console.
- Client navigation from `/pickups` with a cold cache (`router.push`): `get_shipments_list` and `shipment_badge_counts` at 120 ms, nothing else until the rows were in and the browser idle: page two at 1.4 s, the connections and features at 1.8 s (the pane was in the background, which stretches idle callbacks).
- Needs Attention view (two flagged rows, four pins): zero `get-address-review` requests on load; opening one popover sent one (plus one retry on the local 424: `useAuthenticatedQuery` sets `retry` after spreading the caller's options, so the hook's `retry: false` is ignored; pre-existing, out of scope).

Not verified: production; Safari; a deployment with `DOCUMENTS_MANAGEMENT` on (local metadata has it off, so `document_templates` never fires here).

## Risk Assessment

| Risk | Mitigation |
|---|---|
| A flag whose ERP value differs from the default is read before the registry loads | only on a selection or menu click, both after idle in practice; the same window existed before, shorter by the idle wait |
| The idle flag never flips (a page that is never idle) | 1.5 s deadline on `requestIdleCallback`; plain timeout where it is missing |
| Another page relied on connections being fetched at mount through these hooks | the option defaults to `true`; only the board passes it |
