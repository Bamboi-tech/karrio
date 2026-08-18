import { formatDate, formatDateTime } from "@karrio/lib";

// Written onto the shipment metadata by the ERP (karrio_shipping) when the
// Shopify order sits on hold. Presence of the key IS the signal — the value is
// "1" (held, no timestamp) or an ISO timestamp (held since that moment). The
// client must mirror the server's metadata_key filter, which also only tests
// presence, so held/not-held may never depend on the value.
export const SHOPIFY_HOLD_KEY = "shopify_hold";

export interface ShopifyHold {
  held: boolean;
  // ISO date or datetime string when the ERP recorded one, otherwise null.
  since: string | null;
}

// `metadata` is an untyped JSON scalar on the GraphQL schema, so the key is
// narrowed here rather than trusted by the callers.
export function getShopifyHold(metadata: unknown): ShopifyHold {
  const values = (metadata || {}) as Record<string, unknown>;
  if (!(SHOPIFY_HOLD_KEY in values)) return { held: false, since: null };
  const raw = values[SHOPIFY_HOLD_KEY];
  const since =
    typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw : null;
  return { held: true, since };
}

// Shared tooltip for every surface that blocks label purchase on a hold.
// NOTE: this (and every hold check in the dashboard) is UI courtesy only —
// the authoritative enforcement lives in the ERP's gates (karrio_shipping)
// and, in phase 2, in the Karrio server itself.
export function shopifyHoldTooltip(hold: ShopifyHold): string {
  const since = hold.since
    ? ` (since ${hold.since.length > 10 ? formatDateTime(hold.since) : formatDate(hold.since)})`
    : "";
  return `On hold in Shopify${since} — release the hold before buying a label`;
}
