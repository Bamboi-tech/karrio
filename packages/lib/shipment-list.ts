import type { ShipmentFilter, ShipmentListPreferences } from "@karrio/types";
import {
  DEFAULT_SHIPMENT_LIST_PREFERENCES,
  normalizeShipmentListPreferences,
} from "./shipment-list-preferences";

// What the shipments board's server page and its client module must agree
// on: the filter a URL maps to (and so the react-query key), the filter the
// API is actually asked, and the cookie that tells the server how this
// browser renders the list. Kept free of browser and React imports so both
// sides import the very same functions.

export const SHIPMENT_PAGE_SIZE = 20;
export const SHIPMENT_PAGE_SIZE_OPTIONS = [20, 50, 100];
const PAGINATION = { offset: 0, first: SHIPMENT_PAGE_SIZE };

// The Failed card renders its own list; no page of shipments sits behind it.
export const FAILED_SENTINEL = "_failed_creation";

// The All card and the initial query share this list. "draft" rides along
// since the All card started speaking card language (cardStatus in the
// board): a draft row there names its own card — Today, Planned, On hold,
// Needs Attention — instead of the Karrio status, so there is no longer any
// reason to keep drafts off the All card.
export const ALL_STATUSES = [
  "draft",
  "created",
  "shipped",
  "delivered",
  "in_transit",
  "cancelled",
  "needs_attention",
  "out_for_delivery",
  "delivery_failed",
];

// URL sentinels that map to the API's warehouse_view filter.
const WAREHOUSE_VIEWS: Record<string, string> = {
  _print_today: "today",
  _print_planned: "planned",
  _review_clear: "complete",
  _picked: "picked",
};

// Normalizes filter input from any source — a hook's defaults, the URL (all
// strings) or a setFilter call — into the shape the query is keyed and sent
// with. Shared by the server page, the state initializer and setFilter so a
// deep link seeds exactly the filter a later setFilter would have produced.
export function parseShipmentFilter(
  options: Record<string, unknown>,
): ShipmentFilter {
  return Object.keys(options).reduce((acc, key) => {
    if (["modal"].includes(key)) return acc;
    // A key explicitly set to undefined means "clear this filter". Dropping
    // it here keeps it out of the URL too — URLSearchParams would otherwise
    // stringify it to a literal "undefined", which then round-trips back in
    // as a real filter value. The string check heals URLs already polluted
    // that way.
    const value = options[key];
    if (value == null || value === "undefined") return acc;
    // Multi-value filters: a comma-joined URL param must round-trip back
    // into a list (fulfilment_mode is the Bamboi fork's route filter).
    if (["carrier_name", "status", "service", "fulfilment_mode"].includes(key))
      return {
        ...acc,
        [key]: ([] as unknown[])
          .concat(value as string | string[])
          .flatMap((item) =>
            typeof item === "string" ? item.split(",") : [item],
          )
          .map((v) => (v === "purchased" ? "created" : v)),
      };
    if (["offset", "first"].includes(key))
      return {
        ...acc,
        [key]: parseInt(value as string),
      };
    if (
      ["has_tracker", "has_manifest"].includes(key) ||
      ["true", "false"].includes(value as string)
    )
      return {
        ...acc,
        [key]: value === true || value === "true",
      };

    return {
      ...acc,
      [key]: value,
    };
  }, PAGINATION as ShipmentFilter);
}

// The filter a list starts with: its defaults, overridden by the URL.
export function initialShipmentFilter(
  defaults: Record<string, unknown>,
  searchParams?: Record<string, string | string[] | undefined> | null,
): ShipmentFilter {
  // A repeated URL param arrives as a list on the server; the browser's
  // URLSearchParams entries keep the last one.
  const params = Object.entries(searchParams || {}).map(([key, value]) => [
    key,
    Array.isArray(value) ? value[value.length - 1] : value,
  ]);
  return parseShipmentFilter({ ...defaults, ...Object.fromEntries(params) });
}

// Underscore-prefixed statuses are UI sentinels (the Failed card's
// "_failed_creation", the address-review card's "_address_review"): they
// keep a FiltersCard highlighted but are not server-side statuses. Strip
// them from the outgoing query; the rest of the filter still applies.
export function shipmentQueryFilter(filter: ShipmentFilter): ShipmentFilter {
  const statuses = ([] as string[]).concat((filter.status as string[]) || []);
  const status = statuses.filter((s) => !`${s}`.startsWith("_"));
  const warehouseView = statuses.map((s) => WAREHOUSE_VIEWS[s]).find(Boolean);
  return {
    ...filter,
    ...(warehouseView ? { warehouse_view: warehouseView } : {}),
    ...(status.length ? { status } : { status: undefined }),
  } as ShipmentFilter;
}

export const isFailedShipmentsView = (filter: ShipmentFilter) =>
  ([] as string[])
    .concat((filter.status as string[]) || [])
    .includes(FAILED_SENTINEL);

// How one browser shows the board: the operator's list preferences, page
// size and time zone. localStorage stays the source of truth on the client;
// the cookie below mirrors it so the server page can fetch and render the
// first page exactly as the hydrating client will.
export type ShipmentListView = {
  preferences: ShipmentListPreferences;
  first: number;
  // IANA zone the browser reported; null until it has, and then the server
  // cannot format a timestamp the way the browser will.
  timeZone: string | null;
};

export const SHIPMENT_LIST_COOKIE = "karrio_shipment_list";
const SHIPMENT_LIST_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

// Preferences are stored per user, organization and mode; the cookie is one
// per browser. A short hash ties it to its owner without putting the email
// address in a request header.
export function shipmentListScope(
  userId?: string | null,
  orgId?: string | null,
  testMode?: boolean | null,
): string {
  const key = `${(userId || "").toLowerCase()}:${orgId || "personal"}:${testMode ? "test" : "live"}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index++) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

const validTimeZone = (zone: unknown): string | null => {
  if (typeof zone !== "string" || !zone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
};

// Never throws: a missing, foreign or mangled cookie yields the defaults,
// which is also what a browser without stored preferences renders.
export function parseShipmentListView(
  raw: string | null | undefined,
  scope: string,
): ShipmentListView {
  let value: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object") value = parsed;
  } catch {
    // Not ours, or cut off by a proxy: defaults.
  }
  return {
    preferences:
      value.scope === scope
        ? normalizeShipmentListPreferences(value)
        : DEFAULT_SHIPMENT_LIST_PREFERENCES,
    first: SHIPMENT_PAGE_SIZE_OPTIONS.includes(value.first as number)
      ? (value.first as number)
      : SHIPMENT_PAGE_SIZE,
    timeZone: validTimeZone(value.timeZone),
  };
}

export function writeShipmentListCookie(scope: string, view: ShipmentListView) {
  const value = JSON.stringify({
    scope,
    ...view.preferences,
    first: view.first,
    timeZone: view.timeZone,
  });
  document.cookie = `${SHIPMENT_LIST_COOKIE}=${encodeURIComponent(value)};path=/;max-age=${SHIPMENT_LIST_COOKIE_MAX_AGE};samesite=lax`;
}

// The board's defaults for a view; the URL overrides them.
export const shipmentListDefaults = (
  view: Pick<ShipmentListView, "preferences" | "first">,
): Record<string, unknown> => ({
  status: ALL_STATUSES,
  first: view.first,
  ...(view.preferences.sort ? { order_by: view.preferences.sort } : {}),
});

// The filter the board opens with for a URL and a view. The server page
// fetches with it and the client keys its query on it: one function, so the
// two cannot drift.
export const shipmentListFilter = (
  searchParams: Record<string, string | string[] | undefined> | null,
  view: Pick<ShipmentListView, "preferences" | "first">,
): ShipmentFilter =>
  initialShipmentFilter(shipmentListDefaults(view), searchParams);
