// The Pick & Print popup's pure core: grouping a frozen shipment selection
// into the pick list the warehouse walks. No React in here — this module is
// unit-tested on its own (see packages/ui/tests/picklist.test.ts).
//
// Buying is grouped the way boxes are packed, because that is what puts the
// right label on the right box. The Monta flow seeds one parcel per product
// unit, so within one SKU every box is identical and any label of the batch
// fits any box of the stack. That invariant is CHECKED per shipment, not
// assumed: a direct-carrier order packs all units into one parcel
// (parcels ≠ units), so its one label covers a box with different contents —
// it is packed one at a time, never pooled into a stack.

const SELF_DELIVERY = "self_delivery";
export const OWN_DELIVERY_METHOD = "Own delivery";
// A Monta-flow row without a mirrored checkout choice (older drafts miss the
// shipping_method key until their next metadata mirror) still needs a column
// to land in — the honest name is the broker, not a guessed carrier.
const FALLBACK_METHOD = "Monta";

export interface PicklistShipmentLike {
  id: string;
  metadata?: unknown;
  parcels?: Array<{
    items?: Array<{
      sku?: string | null;
      title?: string | null;
      quantity?: number | null;
    }> | null;
  }> | null;
}

export interface ShipmentSummary {
  id: string;
  orderLabel: string;
  method: string;
  own: boolean;
  units: number;
  // One label per PARCEL — which equals units only on the per-unit Monta
  // flow. A direct-carrier order is one parcel however many units it holds.
  labels: number;
}

export interface SkuGroup {
  sku: string;
  title: string;
  total: number;
  perMethod: Record<string, number>;
  shipments: ShipmentSummary[];
  // What Print buys: carrier shipments only — own delivery never buys a
  // label, its boxes go on the van and the row is pick-only.
  buyable: ShipmentSummary[];
}

export interface MixedOrder extends ShipmentSummary {
  lines: Array<{ sku: string; qty: number }>;
}

export interface Picklist {
  groups: SkuGroup[];
  mixed: MixedOrder[];
  methods: string[];
  // Fail-visible: rows without order lines cannot be aggregated, and a pick
  // list that silently omits them would read as "nothing to pick" for
  // exactly the orders that need attention.
  shipmentsWithoutItems: number;
}

export interface BuyResult {
  purchased: string[];
  failures: string[];
  failedIds: string[];
}

export interface PrintConfirmation {
  printed: string[];
  unconfirmed: string[];
}

const metadataOf = (shipment: PicklistShipmentLike): Record<string, unknown> =>
  (shipment.metadata || {}) as Record<string, unknown>;

const shipmentMethod = (shipment: PicklistShipmentLike): string => {
  const values = metadataOf(shipment);
  if (values["fulfilment_mode"] === SELF_DELIVERY) return OWN_DELIVERY_METHOD;
  const method = (values["shipping_method"] as string | undefined)?.trim();
  return method || FALLBACK_METHOD;
};

// The name the warehouse works with (same doctrine as the shipments table):
// the Shopify order number, falling back to the Karrio id.
const orderLabelOf = (shipment: PicklistShipmentLike): string =>
  (metadataOf(shipment)["shopify_order_number"] as string | undefined) ||
  shipment.id;

export const labelCount = (shipments: ShipmentSummary[]): number =>
  shipments.reduce((total, shipment) => total + shipment.labels, 0);

export function buildPicklist(shipments: PicklistShipmentLike[]): Picklist {
  const groups = new Map<string, SkuGroup>();
  const mixed: MixedOrder[] = [];
  const methods = new Set<string>();
  let shipmentsWithoutItems = 0;

  for (const shipment of shipments) {
    const perSku = new Map<string, { qty: number; title: string }>();
    for (const item of (shipment.parcels || []).flatMap((p) => p.items || [])) {
      const sku = (item.sku || "").trim();
      const quantity = item.quantity || 0;
      if (!sku || quantity <= 0) continue;
      const line = perSku.get(sku) || { qty: 0, title: item.title || "" };
      perSku.set(sku, {
        qty: line.qty + quantity,
        title: line.title || item.title || "",
      });
    }

    if (perSku.size === 0) {
      shipmentsWithoutItems += 1;
      continue;
    }

    const method = shipmentMethod(shipment);
    const own = method === OWN_DELIVERY_METHOD;
    methods.add(method);
    const lines = Array.from(perSku, ([sku, { qty }]) => ({ sku, qty }));
    const units = lines.reduce((total, line) => total + line.qty, 0);
    const summary: ShipmentSummary = {
      id: shipment.id,
      orderLabel: orderLabelOf(shipment),
      method,
      own,
      units,
      labels: (shipment.parcels || []).length || 1,
    };

    // A stack row promises "any label of this batch fits any box of this
    // stack". That holds only for a single-SKU order whose every unit is its
    // own parcel (Monta seeds one parcel per unit). A single-SKU order boxed
    // as one parcel for several units (the direct-carrier layout) breaks the
    // promise — its label states that box's weight and contents — so it is
    // packed one at a time alongside the genuinely mixed orders.
    if (perSku.size > 1 || summary.labels !== units) {
      mixed.push({ ...summary, lines });
      continue;
    }

    const [sku, { qty, title }] = Array.from(perSku)[0];
    const group = groups.get(sku) || {
      sku,
      title,
      total: 0,
      perMethod: {},
      shipments: [],
      buyable: [],
    };
    groups.set(sku, {
      ...group,
      title: group.title || title,
      total: group.total + qty,
      perMethod: {
        ...group.perMethod,
        [method]: (group.perMethod[method] || 0) + qty,
      },
      shipments: [...group.shipments, summary],
      buyable: own ? group.buyable : [...group.buyable, summary],
    });
  }

  return {
    groups: Array.from(groups.values()).sort((a, b) =>
      a.sku.localeCompare(b.sku),
    ),
    mixed: mixed.sort((a, b) => a.orderLabel.localeCompare(b.orderLabel)),
    // Own delivery closes the walk: the van is loaded after the parcels.
    methods: Array.from(methods).sort((a, b) =>
      a === OWN_DELIVERY_METHOD
        ? 1
        : b === OWN_DELIVERY_METHOD
          ? -1
          : a.localeCompare(b),
    ),
    shipmentsWithoutItems,
  };
}
