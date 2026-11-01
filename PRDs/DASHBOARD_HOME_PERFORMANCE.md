# Dashboard Home Performance

**Status:** Implemented (Bamboi fork) · **Scope:** `apps/dashboard`, `packages/core`, `packages/hooks`, `packages/ui`, `packages/lib`, `modules/graph` · **Date:** 2026-10-31

---

## Executive Summary

The dashboard home (`/`) felt slow for signed-in operators although every API call it makes answers within ~60 ms of a bare round trip. The remaining cost was in the browser: the usage cards were fetched after hydration, the sparklines pulled a chart library, every page preloaded ten font files for fonts that were never applied, and Font Awesome's CSS sat on the critical path for icons that lucide already provides. This change removes those four costs without touching behaviour.

### Key Architecture Decisions

1. **Cache `system_usage` server-side per 5-minute window.** The hook sends `moment().toISOString()` bounds that differ per call; the resolver rounds the window outwards to 5-minute marks, uses the rounded bounds as cache key and as query bounds, and caches the plain aggregation result for 300 s in the Django cache (Redis in production). Every series is aggregated per day, so a window widened by at most five minutes per side yields the same chart.
2. **Prefetch the default range during SSR.** A server component wraps the client module and loads the default (15-day) usage with the user's token, in parallel with the dashboard layout's own loaders. The client hook receives it as react-query `initialData` for the default range only; any other range fetches as before. `MULTI_ORGANIZATIONS` deployments skip the prefetch (their usage comes from the ee schema) and keep the client path.
3. **Plain SVG sparklines.** The four 120 px bar charts are rendered with an SVG component in `@karrio/ui`; the recharts chunk no longer loads on the home page.
4. **One font, one file.** `packages/ui/fonts/font.ts` instantiated seven Google fonts; only Open Sans was applied, yet next/font preloaded every file. Open Sans is now loaded as the variable font, latin subset.
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

`system_usage:<org pk or ->:<test_mode>:<date_after floor 5 min>:<date_before ceil 5 min>`

---

## Implementation

| File | Change |
|---|---|
| `modules/graph/karrio/server/graph/schemas/base/types.py` | `_usage_window`, `_system_usage_cache_key`, `_compute_system_usage`; `SystemUsageType.resolve` reads the cache |
| `modules/graph/karrio/server/graph/tests/test_system_usage.py` | window rounding, key separation, cache hit, recompute on another window |
| `packages/lib/helper.ts` | `DEFAULT_USAGE_RANGE`, `USAGE_RANGE_DAYS`, `usageFilterFor` |
| `packages/hooks/usage.ts` | filters built from the shared table; `initialUsage` option → `initialData` for the default range |
| `packages/core/context/main.ts` | `loadSystemUsage` (60 s Next cache, never caches an error) |
| `packages/core/modules/Dashboard/page.tsx` | server entry; `index.tsx` takes `initialUsage`; `charts.tsx` removed |
| `apps/dashboard/src/app/(base)/**/(dashboard)/page.tsx` (4 routes) | export the server entry |
| `packages/ui/components/usage-sparkline.tsx` | SVG bars with native tooltips and first/last labels |
| `packages/ui/fonts/font.ts`, `packages/ui/layouts/root-layout.tsx` | Open Sans variable only |
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
| Stale usage for up to 5 min (API) + 60 s (Next) | Acceptable for a dashboard overview; the range selector still fetches live for other ranges after the API bucket |
| Rounded bounds differ from the client's exact bounds | Day-level series; the extra ≤5 min lies on a day edge the chart already shows as partial |
| Lucide icon sizing differs from Font Awesome glyphs | Sizes mapped per class (`fa-lg` → `h-5 w-5`, `text-xs` → `h-3 w-3`); visual check on staging |
| Variable font rendering | Same family and weights; `display: swap` unchanged |

## Migration & Rollback

No schema or data migration. Rollback is a redeploy of the previous image tag.
