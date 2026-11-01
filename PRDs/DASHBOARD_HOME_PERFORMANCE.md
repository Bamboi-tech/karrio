# Dashboard Home Performance

**Status:** Implemented (Bamboi fork), reviewed by Codex 2026-10-31 (reviews/codex-review-2026-10-31-2225-dashboard-home-perf.md, not committed) · **Scope:** `apps/dashboard`, `packages/core`, `packages/hooks`, `packages/ui`, `packages/lib`, `modules/graph` · **Date:** 2026-10-31

---

## Executive Summary

The dashboard home (`/`) felt slow for signed-in operators although every API call it makes answers within ~60 ms of a bare round trip. The remaining cost was in the browser: the usage cards were fetched after hydration, the sparklines pulled a chart library, every page preloaded ten font files for fonts that were never applied, and Font Awesome's CSS sat on the critical path for icons that lucide already provides. This change removes those four costs without touching behaviour.

### Key Architecture Decisions

1. **Cache `system_usage` server-side per aligned 5-minute window.** The dashboard aligns its own bounds to the 5-minute mark (`usageFilterFor` in `@karrio/lib`), so every visitor in the same five minutes asks for the same window. The resolver honours the requested bounds exactly for every caller and caches the plain aggregation result for 300 s in the Django cache (Redis in production) only when both bounds sit on a 5-minute mark, so ad-hoc API queries never fill the cache with one-off keys.
2. **Prefetch the default range during SSR.** A server component wraps the client module and loads the default (15-day) usage with the user's token, in parallel with the dashboard layout's own loaders, with a 3 s deadline after which the client fetches as before. The prefetch carries the exact window and its fetch time: the client hook uses that window as its initial filter (so server HTML and hydration render the same thing) and seeds react-query with `initialData` plus `initialDataUpdatedAt` for that key only. Day labels are formatted in UTC on both sides, matching the API's UTC day buckets. `MULTI_ORGANIZATIONS` deployments skip the prefetch (their usage comes from the ee schema) and keep the client path.
3. **Plain SVG sparklines.** The four 120 px bar charts are rendered with an SVG component in `@karrio/ui`; the recharts chunk no longer loads on the home page.
4. **One font, one file.** `packages/ui/fonts/font.ts` instantiated seven Google fonts; the dashboard applied only Open Sans, yet next/font preloaded every file instantiated in the import graph. Open Sans moves to `packages/ui/fonts/open-sans.ts` as the variable latin font; `font.ts` keeps the fonts `apps/web` and the console use.
5. **Font Awesome removed.** All icons in reachable code are lucide components; the CSS import and the dependency are gone from `packages/core`.

### Scope

| In Scope | Out of Scope |
|----------|--------------|
| `system_usage` resolver cache + tests | VM sizing (e2-standard-2, pd-balanced) |
| Server prefetch of default usage | Organization usage (ee) prefetch |
| SVG sparkline component | Other recharts users (Shippers, developer tools) |
| Font trim | Bulma / Tailwind consolidation |
| Font Awesome → lucide in reachable files | 14 unreferenced files that still carry `fa-` classes (dead code, listed below) |

---

## Problem Statement

### Current State

```
browser GET /                 → Next layout chain (cached 60 s)        ~0.1 s
  ↓ HTML without numbers
  ↓ 10 woff2 preloads (269 KB) + Font Awesome CSS + app chunks
  ↓ hydrate
  ↓ POST /graphql system_usage  (5 aggregations, uncached)             ~0.1 s
  ↓ fetch recharts chunk
  → cards and charts appear
```

### Desired State

```
browser GET /                 → layout chain ‖ page: system_usage (API cache hit, Next cache 60 s)
  ↓ HTML with the four cards and SVG sparklines
  ↓ 1 woff2 preload, no icon font CSS
  ↓ hydrate; react-query seeded, no usage request for the default range
```

---

## Technical Design

### Existing Code Analysis

| Studied | Reused |
|---|---|
| `packages/core/context/main.ts` `loadUserData` / `withResultCache` | same cache wrapper and header scheme for `loadSystemUsage` |
| `packages/core/components/metadata.tsx` `loadRequestMetadata` | request-deduplicated metadata in the server page |
| `modules/core/karrio/server/core/views/references.py` | cache-key-and-TTL pattern for the resolver |
| `packages/hooks/usage.ts` | `initialData` seam; filter table moved to `@karrio/lib` so client and server share it |
| `packages/core/modules/Dashboard/charts.tsx` | replaced by `packages/ui/components/usage-sparkline.tsx` |

### Sequence

```
page.tsx (server)            layout.tsx (server)             API
  auth()                       auth()
  loadRequestMetadata ───┐     loadRequestMetadata
  loadSystemUsage ───────┼──── POST /graphql GetSystemUsage ──→ cache.get(key)
                         │                                      miss → aggregate → cache.set 300 s
  <DashboardPage initialUsage>   Providers ... {children}
                 ↓
  useAPIUsage({ initialUsage })  → react-query initialData for the default range
```

### Cache key

`system_usage:<org pk or ->:<test_mode>:<date_after>:<date_before>` — set only when both bounds are on a 5-minute mark.

---

## Implementation

| File | Change |
|---|---|
| `modules/graph/karrio/server/graph/schemas/base/types.py` | `_usage_bounds`, `_is_cacheable_window`, `_system_usage_cache_key`, `_compute_system_usage`; `SystemUsageType.resolve` reads the cache for aligned windows |
| `modules/graph/karrio/server/graph/tests/test_system_usage.py` | exact bound parsing, alignment rule, key separation, cache hit, recompute on another window, unaligned windows computed every time with exact bounds |
| `packages/lib/helper.ts` | `DEFAULT_USAGE_RANGE`, `USAGE_RANGE_DAYS`, `usageFilterFor` (5-minute aligned), `usageRangeOf`, `usageDayLabel`, `usageDayLabels` (UTC) |
| `packages/hooks/usage.ts` | filter table and labels built per mount; `initialUsage` (window + fetch time) is the initial filter and seeds `initialData` for that key |
| `packages/hooks/api-metadata.tsx` | reduced references on `/` and `/test` as well as `/shipments` |
| `packages/core/context/main.ts` | `loadSystemUsage` (no Next cache, 3 s deadline, returns `UsagePrefetch`) |
| `packages/core/modules/Dashboard/page.tsx` | server entry; `index.tsx` takes `initialUsage`; `charts.tsx` removed |
| `apps/dashboard/src/app/(base)/**/(dashboard)/page.tsx` (4 routes) | export the server entry |
| `packages/ui/components/usage-sparkline.tsx` | SVG bars with native tooltips and first/last labels |
| `packages/ui/fonts/open-sans.ts`, `packages/ui/fonts/font.ts`, `packages/{core,ui}/layouts/root-layout.tsx` | dashboard imports only Open Sans; web fonts stay in `font.ts` |
| `apps/dashboard/src/app/(base)/layout.tsx`, `packages/core/layouts/{public,embedable}-layout.tsx`, `packages/core/package.json` | Font Awesome import and dependency removed; `lucide-react` declared |
| 50 files under `packages/core/modules`, `packages/ui/core`, `packages/ui/components` | `<i class="fas fa-…">` → lucide components |

Unreferenced files that still contain `fa-` classes (nothing imports them; candidates for deletion in a separate cleanup): `packages/core/components/tracking-preview.tsx`, `packages/core/modules/Home/*`, `packages/ui/core/components/{admin-navbar,app-menu,expandable,expanded-sidebar,footer,workflow-menu}.tsx`, `packages/ui/core/forms/{live-rates,rate-sheet-list,shipment-options,system-carrier-list,user-carrier-list}.tsx`, `packages/ui/core/modals/rate-sheet-edit-modal.tsx`.

---

## Testing Strategy

- `karrio test karrio.server.graph.tests.test_system_usage` (5 tests) and the full `karrio.server.graph.tests` module.
- `npx tsc --noEmit -p apps/dashboard/tsconfig.json` and `next build` for the dashboard.
- After deploy: a signed-in `/` must contain the four stat values in the HTML (`curl` with the session cookie), the network panel must show no `system_usage` request on first load, one `woff2` preload, and no `all.min.css`.

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Usage up to 5 min old (aligned window + API cache) | Acceptable for a dashboard overview; the seed carries its fetch time so a stale server response refetches on mount |
| Server-rendered chart differs from the hydrated one | Window travels with the prefetch; labels are UTC on both sides (verified in UTC, Chicago, Amsterdam, Auckland) |
| Lucide icon sizing differs from Font Awesome glyphs | Sizes mapped per class (`fa-lg` → `h-5 w-5`, `text-xs` → `h-3 w-3`); visual check on staging |
| Variable font rendering | Same family and weights; `display: swap` unchanged |

## Migration & Rollback

No schema or data migration. Rollback is a redeploy of the previous image tag.
