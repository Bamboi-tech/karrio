"use client";

import React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Checkbox } from "./ui/checkbox";
import { Button } from "./ui/button";
import { CheckCircle2, Loader2, Printer, RotateCcw, XCircle } from "lucide-react";

// The Pick & Print popup: the whole warehouse run happens in here.
//
// Buying is grouped the way boxes are packed, because that is what puts the
// right label on the right box. Every product unit ships as its own collo
// (the ERP seeds one parcel per unit), so:
//
// - Orders containing ONE distinct SKU are interchangeable within their SKU:
//   pick the stack, hit Print on that row, and any label of that batch fits
//   any box of that stack.
// - Orders mixing SKUs are packed one at a time: they get their own section
//   with one Print per order, so their labels never mingle with a stack.
//
// A row's status is the printer's truth, not the purchase's: it turns green
// only when the ERP has mirrored `printed_at` — which it stamps after
// PrintNode accepted every job — and red when the purchase failed or the
// printer never confirmed. Grey is "no action yet".
//
// The operator confirms every row (picked + labeled); the closing button
// only unlocks when everything is confirmed.

const SELF_DELIVERY = "self_delivery";
const OWN_DELIVERY_METHOD = "Own delivery";
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

interface ShipmentSummary {
  id: string;
  orderLabel: string;
  method: string;
  own: boolean;
  units: number;
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
      perSku.set(sku, { qty: line.qty + quantity, title: line.title || item.title || "" });
    }

    if (perSku.size === 0) {
      shipmentsWithoutItems += 1;
      continue;
    }

    const method = shipmentMethod(shipment);
    const own = method === OWN_DELIVERY_METHOD;
    methods.add(method);
    const lines = Array.from(perSku, ([sku, { qty }]) => ({ sku, qty }));
    const summary: ShipmentSummary = {
      id: shipment.id,
      orderLabel: orderLabelOf(shipment),
      method,
      own,
      // One parcel per unit, one label per parcel: units IS the label count.
      units: lines.reduce((total, line) => total + line.qty, 0),
    };

    if (perSku.size > 1) {
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
      perMethod: { ...group.perMethod, [method]: (group.perMethod[method] || 0) + qty },
      shipments: [...group.shipments, summary],
      buyable: own ? group.buyable : [...group.buyable, summary],
    });
  }

  return {
    groups: Array.from(groups.values()).sort((a, b) => a.sku.localeCompare(b.sku)),
    mixed: mixed.sort((a, b) => a.orderLabel.localeCompare(b.orderLabel)),
    // Own delivery closes the walk: the van is loaded after the parcels.
    methods: Array.from(methods).sort((a, b) =>
      a === OWN_DELIVERY_METHOD ? 1 : b === OWN_DELIVERY_METHOD ? -1 : a.localeCompare(b),
    ),
    shipmentsWithoutItems,
  };
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

// Grey (idle) → buying → waiting for the printer → green (PrintNode
// confirmed) or red (purchase failed / printer never confirmed). Red keeps a
// Retry over exactly the shipments that still need a label.
type RowState =
  | { phase: "idle" }
  | { phase: "buying" }
  | { phase: "confirming"; labels: number }
  | { phase: "printed"; labels: number }
  | { phase: "failed"; reason: string; retryIds: string[]; retryLabels: number };

const labelCount = (shipments: ShipmentSummary[]): number =>
  shipments.reduce((total, shipment) => total + shipment.units, 0);

export function PicklistDialog({
  open,
  onOpenChange,
  shipments,
  onBuyShipments,
  onAwaitPrinted,
  onConfirmAll,
  onOpenLabels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shipments: PicklistShipmentLike[];
  // Buys (pick + purchase, sequentially) the given shipments. Provided by
  // the page, which owns the mutation hooks and the toasts.
  onBuyShipments: (ids: string[]) => Promise<BuyResult>;
  // Polls the bought shipments until the ERP mirrors printed_at (stamped
  // after PrintNode accepted the jobs) or gives up — the green/red verdict.
  onAwaitPrinted: (ids: string[]) => Promise<PrintConfirmation>;
  // Fired once when the operator confirms the whole run (every row ticked).
  // The page uses it to record the own-delivery picks.
  onConfirmAll?: (ownIds: string[]) => void;
  // PDF fallback over everything bought so far — for the day the printer or
  // PrintNode is down. Absent until something was bought.
  onOpenLabels?: (() => void) | null;
}) {
  const picklist = React.useMemo(() => buildPicklist(shipments), [shipments]);
  const [ticked, setTicked] = React.useState<string[]>([]);
  const [rows, setRows] = React.useState<Record<string, RowState>>({});
  const busy = Object.values(rows).some(
    (row) => row.phase === "buying" || row.phase === "confirming",
  );

  // A fresh run is a fresh sheet: confirmations are about THIS run's boxes,
  // never yesterday's.
  React.useEffect(() => {
    if (open) {
      setTicked([]);
      setRows({});
    }
  }, [open, shipments]);

  const rowKeys = [
    ...picklist.groups.map((group) => `sku:${group.sku}`),
    ...picklist.mixed.map((order) => `order:${order.id}`),
  ];
  const allConfirmed = rowKeys.length > 0 && rowKeys.every((key) => ticked.includes(key));
  const totalLabels =
    labelCount(picklist.groups.flatMap((group) => group.buyable)) +
    labelCount(picklist.mixed.filter((order) => !order.own));

  const setRow = (key: string, state: RowState) =>
    setRows((current) => ({ ...current, [key]: state }));

  const toggle = (key: string, checked: boolean) =>
    setTicked((current) =>
      checked ? [...current, key] : current.filter((k) => k !== key),
    );

  const buy = async (key: string, targets: ShipmentSummary[]) => {
    const labels = labelCount(targets);
    setRow(key, { phase: "buying" });
    try {
      const result = await onBuyShipments(targets.map((t) => t.id));
      if (result.purchased.length === 0) {
        setRow(key, {
          phase: "failed",
          reason: "Purchase failed",
          retryIds: targets.map((t) => t.id),
          retryLabels: labels,
        });
        return;
      }

      setRow(key, { phase: "confirming", labels });
      const confirmation = await onAwaitPrinted(result.purchased);
      const failed = result.failedIds.length + confirmation.unconfirmed.length;
      if (failed > 0) {
        const retrySummaries = targets.filter((t) => result.failedIds.includes(t.id));
        setRow(key, {
          phase: "failed",
          reason:
            confirmation.unconfirmed.length > 0
              ? "Printer did not confirm — check PrintNode, or use Open label PDFs"
              : `${result.failedIds.length} purchase(s) failed`,
          retryIds: retrySummaries.map((t) => t.id),
          retryLabels: labelCount(retrySummaries),
        });
        return;
      }
      setRow(key, { phase: "printed", labels });
    } catch {
      // The page already toasts the failure; the row goes back to printable.
      setRow(key, {
        phase: "failed",
        reason: "Purchase failed",
        retryIds: targets.map((t) => t.id),
        retryLabels: labels,
      });
    }
  };

  const confirmAll = () => {
    onConfirmAll?.(
      [...picklist.groups.flatMap((group) => group.shipments), ...picklist.mixed]
        .filter((shipment) => shipment.own)
        .map((shipment) => shipment.id),
    );
    onOpenChange(false);
  };

  // One cell tells the row's whole story: grey button (nothing happened),
  // spinner (buying / waiting for the printer), green (printer confirmed),
  // red (failed, with a retry over what is still unlabeled).
  const statusCell = (key: string, targets: ShipmentSummary[]) => {
    const state = rows[key] || { phase: "idle" };
    const labels = labelCount(targets);

    if (targets.length === 0) {
      return <span className="text-xs text-muted-foreground">pick only</span>;
    }
    switch (state.phase) {
      case "buying":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Buying…
          </span>
        );
      case "confirming":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for printer…
          </span>
        );
      case "printed":
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {state.labels} label{state.labels === 1 ? "" : "s"} printed
          </span>
        );
      case "failed":
        return (
          <span className="inline-flex items-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700"
              title={state.reason}
            >
              <XCircle className="h-3.5 w-3.5" /> Failed
            </span>
            {state.retryIds.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={busy}
                onClick={() =>
                  buy(key, targets.filter((t) => state.retryIds.includes(t.id)))
                }
              >
                <RotateCcw className="h-3 w-3 mr-1" /> Retry
              </Button>
            )}
          </span>
        );
      default:
        return (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={busy}
            onClick={() => buy(key, targets)}
          >
            <Printer className="h-3.5 w-3.5 mr-1.5" />
            Print {labels} label{labels === 1 ? "" : "s"}
          </Button>
        );
    }
  };

  const rowTone = (key: string, isTicked: boolean) => {
    const phase = (rows[key] || { phase: "idle" }).phase;
    if (phase === "printed") return "bg-emerald-50/50";
    if (phase === "failed") return "bg-red-50/50";
    return isTicked ? "bg-muted/40" : "";
  };

  const headerCell = "py-2 px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground";
  const numberCell = "py-2.5 px-3 text-right tabular-nums";

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between pr-6">
            <span>Pick &amp; Print</span>
            <span className="text-sm font-normal text-muted-foreground">
              {shipments.length} order{shipments.length === 1 ? "" : "s"} ·{" "}
              {totalLabels} label{totalLabels === 1 ? "" : "s"} · {ticked.length}/
              {rowKeys.length} confirmed
            </span>
          </DialogTitle>
          <DialogDescription>
            Pick per row, hit Print once the stack of boxes is packed — any
            label from that batch fits any box in the row. Stick the labels,
            tick the row. Mixed orders are packed one at a time.
          </DialogDescription>
        </DialogHeader>

        {picklist.shipmentsWithoutItems > 0 && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {picklist.shipmentsWithoutItems} shipment(s) carry no order lines —
            they are not on this list and need handling from the order itself.
          </p>
        )}

        {rowKeys.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nothing to pick in this selection.
          </p>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto rounded-md border">
            {picklist.groups.length > 0 && (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background shadow-[0_1px_0_0_hsl(var(--border))]">
                  <tr className="text-left">
                    <th className={`${headerCell} w-10`}></th>
                    <th className={headerCell}>SKU</th>
                    {picklist.methods.map((method) => (
                      <th key={method} className={`${headerCell} text-right whitespace-nowrap`}>
                        {method}
                      </th>
                    ))}
                    <th className={`${headerCell} text-right`}>Total</th>
                    <th className={`${headerCell} text-right pr-3`}>Labels</th>
                  </tr>
                </thead>
                <tbody>
                  {picklist.groups.map((group) => {
                    const key = `sku:${group.sku}`;
                    const isTicked = ticked.includes(key);
                    return (
                      <tr
                        key={key}
                        className={`border-t ${rowTone(key, isTicked)}`}
                      >
                        <td className="py-2.5 px-3">
                          <Checkbox
                            checked={isTicked}
                            onCheckedChange={(checked) => toggle(key, checked === true)}
                          />
                        </td>
                        <td className={`py-2.5 px-3 ${isTicked ? "text-muted-foreground line-through" : ""}`}>
                          <span className="font-medium">{group.sku}</span>
                          {group.title && (
                            <span className="block text-xs text-muted-foreground">
                              {group.title}
                            </span>
                          )}
                        </td>
                        {picklist.methods.map((method) => (
                          <td key={method} className={numberCell}>
                            {group.perMethod[method] || ""}
                          </td>
                        ))}
                        <td className={`${numberCell} font-semibold`}>{group.total}</td>
                        <td className="py-2.5 px-3 text-right whitespace-nowrap">
                          {statusCell(key, group.buyable)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {picklist.mixed.length > 0 && (
              <div className={picklist.groups.length > 0 ? "border-t" : ""}>
                <p className="px-3 pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Mixed orders — pack one at a time
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    {picklist.mixed.map((order) => {
                      const key = `order:${order.id}`;
                      const isTicked = ticked.includes(key);
                      return (
                        <tr key={key} className={`border-t ${rowTone(key, isTicked)}`}>
                          <td className="py-2.5 px-3 w-10">
                            <Checkbox
                              checked={isTicked}
                              onCheckedChange={(checked) => toggle(key, checked === true)}
                            />
                          </td>
                          <td className={`py-2.5 px-3 ${isTicked ? "text-muted-foreground line-through" : ""}`}>
                            <span className="font-medium">{order.orderLabel}</span>
                            <span className="block text-xs text-muted-foreground">
                              {order.lines.map((line) => `${line.qty}× ${line.sku}`).join(" · ")}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-right text-xs text-muted-foreground whitespace-nowrap">
                            {order.method}
                          </td>
                          <td className="py-2.5 px-3 text-right whitespace-nowrap">
                            {statusCell(key, order.own ? [] : [order])}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {onOpenLabels && (
              <Button variant="outline" size="sm" onClick={onOpenLabels}>
                Open label PDFs
              </Button>
            )}
          </div>
          <Button
            size="sm"
            disabled={!allConfirmed || busy}
            title={allConfirmed ? undefined : "Tick every row first"}
            onClick={confirmAll}
          >
            All picked &amp; labeled
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
