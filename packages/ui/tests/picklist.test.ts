// The Pick & Print grouping invariants (see components/picklist.ts). These
// pin the two facts the popup's safety rests on: a stack row only ever pools
// boxes whose labels are interchangeable, and the label counts the operator
// reads are parcel counts, not unit counts.

import { describe, expect, it } from "vitest";
import { buildPicklist, labelCount } from "../components/picklist";

// The ERP's Monta layout: one parcel per product unit, order lines riding on
// the first parcel only (shipments.py:_parcels_from_settings).
const montaShipment = (
  id: string,
  sku: string,
  qty: number,
  metadata: Record<string, unknown> = {},
) => ({
  id,
  metadata: { shipping_method: "PostNL", ...metadata },
  parcels: [
    { items: [{ sku, title: sku.toLowerCase(), quantity: qty }] },
    ...Array.from({ length: qty - 1 }, () => ({ items: [] })),
  ],
});

// The ERP's direct-carrier layout: every unit in ONE weighed parcel
// (shipments.py:_parcels_from_items) — one label for the whole box.
const directShipment = (id: string, sku: string, qty: number) => ({
  id,
  metadata: { shipping_method: "DHL" },
  parcels: [{ items: [{ sku, title: sku.toLowerCase(), quantity: qty }] }],
});

describe("buildPicklist", () => {
  it("pools per-unit single-SKU orders into one stack with per-parcel labels", () => {
    const picklist = buildPicklist([
      montaShipment("shp_1", "BAM-01", 2),
      montaShipment("shp_2", "BAM-01", 1),
    ]);

    expect(picklist.groups).toHaveLength(1);
    expect(picklist.mixed).toHaveLength(0);
    const [group] = picklist.groups;
    expect(group.total).toBe(3);
    expect(group.perMethod).toEqual({ PostNL: 3 });
    expect(labelCount(group.buyable)).toBe(3);
  });

  it("keeps a multi-unit single-parcel order out of the stack", () => {
    // Two units in one direct-carrier box: its single label states that
    // box's weight and contents, so it must not be pooled with per-unit
    // boxes of the same SKU where "any label fits any box".
    const picklist = buildPicklist([
      montaShipment("shp_1", "BAM-01", 1),
      directShipment("shp_2", "BAM-01", 2),
    ]);

    expect(picklist.groups.map((g) => g.shipments.map((s) => s.id))).toEqual([
      ["shp_1"],
    ]);
    expect(picklist.mixed.map((m) => m.id)).toEqual(["shp_2"]);
    expect(picklist.mixed[0].labels).toBe(1);
    expect(picklist.mixed[0].units).toBe(2);
    expect(picklist.mixed[0].lines).toEqual([{ sku: "BAM-01", qty: 2 }]);
  });

  it("keeps SKU-mixing orders out of the stack", () => {
    const picklist = buildPicklist([
      {
        id: "shp_3",
        metadata: { shipping_method: "PostNL" },
        parcels: [
          { items: [{ sku: "BAM-01", quantity: 1 }] },
          { items: [{ sku: "BAM-02", quantity: 1 }] },
        ],
      },
    ]);

    expect(picklist.groups).toHaveLength(0);
    expect(picklist.mixed.map((m) => m.lines)).toEqual([
      [
        { sku: "BAM-01", qty: 1 },
        { sku: "BAM-02", qty: 1 },
      ],
    ]);
  });

  it("never buys own-delivery rows and sorts their column last", () => {
    const picklist = buildPicklist([
      montaShipment("shp_1", "BAM-01", 1),
      montaShipment("shp_4", "BAM-01", 1, { fulfilment_mode: "self_delivery" }),
    ]);

    const [group] = picklist.groups;
    expect(group.shipments).toHaveLength(2);
    expect(group.buyable.map((s) => s.id)).toEqual(["shp_1"]);
    expect(picklist.methods).toEqual(["PostNL", "Own delivery"]);
  });

  it("reports shipments without order lines instead of dropping them silently", () => {
    const picklist = buildPicklist([
      { id: "shp_5", metadata: {}, parcels: [{ items: [] }] },
      montaShipment("shp_1", "BAM-01", 1),
    ]);

    expect(picklist.shipmentsWithoutItems).toBe(1);
    expect(picklist.groups).toHaveLength(1);
  });

  it("labels a method-less row with the broker, not a guessed carrier", () => {
    const picklist = buildPicklist([
      {
        id: "shp_6",
        metadata: {},
        parcels: [{ items: [{ sku: "BAM-01", quantity: 1 }] }],
      },
    ]);

    expect(picklist.groups[0].perMethod).toEqual({ Monta: 1 });
  });
});
