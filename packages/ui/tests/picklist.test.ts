// The Pick & Print grouping invariants (see components/picklist.ts). These
// pin the two facts the popup's safety rests on: a stack row only ever pools
// boxes whose labels are interchangeable, and the label counts the operator
// reads are parcel counts, not unit counts.

import { describe, expect, it } from "vitest";
import {
  awaitPrintConfirmation,
  buildPicklist,
  labelCount,
} from "../components/picklist";

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

// The print poll runs on a fake clock: sleep() advances it, fetchPrinted()
// answers from a per-shipment "printed at" schedule, so the test reads like
// the ERP's confirmation stream instead of waiting on real timers.
const printStream = (printedAt: Record<string, number>) => {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    fetchPrinted: async (wanted: string[]) =>
      wanted.filter(
        (id) => printedAt[id] !== undefined && printedAt[id] <= clock,
      ),
  };
};

describe("awaitPrintConfirmation", () => {
  const timing = { idleTimeoutMs: 90_000, maxWaitMs: 900_000, pollMs: 3_000 };

  it("keeps waiting while the printer keeps confirming, however long the stack", async () => {
    // 23-09: one 28-box stack; the ERP confirmed a label every ~6 s and the
    // last one landed 108 s after the last purchase. A fixed 90 s window
    // turned the row red although every label had printed.
    const ids = Array.from({ length: 28 }, (_, i) => `shp_${i}`);
    const stream = printStream(
      Object.fromEntries(ids.map((id, i) => [id, 5_000 + i * 6_000])),
    );

    const result = await awaitPrintConfirmation({ ids, ...timing, ...stream });

    expect(result.unconfirmed).toEqual([]);
    expect(result.printed).toHaveLength(28);
    expect(stream.now()).toBeGreaterThan(90_000);
  });

  it("gives up when the printer stays silent for the whole idle window", async () => {
    const stream = printStream({ shp_1: 4_000 });

    const result = await awaitPrintConfirmation({
      ids: ["shp_1", "shp_2"],
      ...timing,
      ...stream,
    });

    expect(result.printed).toEqual(["shp_1"]);
    expect(result.unconfirmed).toEqual(["shp_2"]);
    // Silent since the 4 s confirmation: the verdict comes one idle window
    // later, not one window after the start.
    expect(stream.now()).toBeGreaterThanOrEqual(4_000 + 90_000);
    expect(stream.now()).toBeLessThan(4_000 + 90_000 + 2 * 3_000);
  });

  it("names the one jammed label of a big stack one idle window after the rest", async () => {
    // The rest of the stack keeps re-arming the window; the stuck label is
    // reported once the printer has gone quiet, not while it is still busy.
    const ids = Array.from({ length: 28 }, (_, i) => `shp_${i}`);
    const stream = printStream(
      Object.fromEntries(
        ids
          .filter((id) => id !== "shp_13")
          .map((id, i) => [id, 5_000 + i * 6_000]),
      ),
    );
    const lastConfirmation = 5_000 + 26 * 6_000;

    const result = await awaitPrintConfirmation({ ids, ...timing, ...stream });

    expect(result.unconfirmed).toEqual(["shp_13"]);
    expect(result.printed).toHaveLength(27);
    expect(stream.now()).toBeGreaterThanOrEqual(lastConfirmation + 90_000);
    expect(stream.now()).toBeLessThan(lastConfirmation + 90_000 + 2 * 3_000);
  });

  it("stops at the hard ceiling even while confirmations keep trickling in", async () => {
    // The popup cannot be closed while a row waits for the printer, so the
    // idle window alone must not hold it for n × 90 s.
    const ids = Array.from({ length: 20 }, (_, i) => `shp_${i}`);
    const stream = printStream(
      Object.fromEntries(ids.map((id, i) => [id, (i + 1) * 80_000])),
    );

    const result = await awaitPrintConfirmation({ ids, ...timing, ...stream });

    expect(result.unconfirmed.length).toBeGreaterThan(0);
    expect(result.printed.length + result.unconfirmed.length).toBe(20);
    expect(stream.now()).toBeGreaterThanOrEqual(900_000);
    expect(stream.now()).toBeLessThan(900_000 + 3_000);
  });

  it("gives up after one idle window when nothing ever confirms", async () => {
    const stream = printStream({});

    const result = await awaitPrintConfirmation({
      ids: ["shp_1"],
      ...timing,
      ...stream,
    });

    expect(result.unconfirmed).toEqual(["shp_1"]);
    expect(stream.now()).toBeGreaterThanOrEqual(90_000);
    expect(stream.now()).toBeLessThan(90_000 + 3_000);
  });

  it("answers at once when the mirror already landed", async () => {
    const stream = printStream({ shp_1: 0 });

    const result = await awaitPrintConfirmation({
      ids: ["shp_1"],
      ...timing,
      ...stream,
    });

    expect(result).toEqual({ printed: ["shp_1"], unconfirmed: [] });
    expect(stream.now()).toBe(0);
  });

  it("keeps polling through transient read failures", async () => {
    const stream = printStream({ shp_1: 10_000 });
    let calls = 0;
    const flaky = async (wanted: string[]) => {
      calls += 1;
      if (calls <= 3) throw new Error("timeout");
      return stream.fetchPrinted(wanted);
    };

    const result = await awaitPrintConfirmation({
      ids: ["shp_1"],
      ...timing,
      now: stream.now,
      sleep: stream.sleep,
      fetchPrinted: flaky,
    });

    expect(result).toEqual({ printed: ["shp_1"], unconfirmed: [] });
  });

  it("reports the confirmations so far after every tick that brings new ones", async () => {
    // The row's "Waiting for printer… 12/29": a big stack waits for minutes,
    // and a bare spinner cannot tell a busy printer from a dead one.
    const stream = printStream({
      shp_1: 0,
      shp_2: 5_000,
      shp_3: 5_000,
      shp_4: 12_000,
    });
    const progress: Array<[number, string[]]> = [];

    const result = await awaitPrintConfirmation({
      ids: ["shp_1", "shp_2", "shp_3", "shp_4"],
      ...timing,
      ...stream,
      onProgress: (printed) => progress.push([stream.now(), printed]),
    });

    // Cumulative snapshots, and nothing on the silent ticks (3 s, 9 s).
    expect(progress).toEqual([
      [0, ["shp_1"]],
      [6_000, ["shp_1", "shp_2", "shp_3"]],
      [12_000, ["shp_1", "shp_2", "shp_3", "shp_4"]],
    ]);
    expect(result).toEqual({
      printed: ["shp_1", "shp_2", "shp_3", "shp_4"],
      unconfirmed: [],
    });
  });

  it("reports nothing on a failed read, a silent tick or after the verdict", async () => {
    const stream = printStream({ shp_1: 3_000 });
    let calls = 0;
    const flaky = async (wanted: string[]) => {
      calls += 1;
      if (calls === 2) throw new Error("timeout");
      return stream.fetchPrinted(wanted);
    };
    const progress: Array<[number, string[]]> = [];

    const result = await awaitPrintConfirmation({
      ids: ["shp_1", "shp_2"],
      ...timing,
      now: stream.now,
      sleep: stream.sleep,
      fetchPrinted: flaky,
      onProgress: (printed) => progress.push([stream.now(), printed]),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toEqual({ printed: ["shp_1"], unconfirmed: ["shp_2"] });
    // shp_1 printed at 3 s, but that read failed: reported on the next one.
    expect(progress).toEqual([[6_000, ["shp_1"]]]);
  });

  it("polls exactly as before without a progress listener", async () => {
    const run = async (onProgress?: (printed: string[]) => void) => {
      const stream = printStream({ shp_1: 4_000, shp_2: 20_000 });
      const result = await awaitPrintConfirmation({
        ids: ["shp_1", "shp_2", "shp_3"],
        ...timing,
        ...stream,
        onProgress,
      });
      return { result, stoppedAt: stream.now() };
    };

    expect(await run()).toEqual(await run(() => {}));
  });

  it("stops polling once the popup is gone", async () => {
    // Leaving the page mid-wait unmounts the popup; its poll must not keep
    // hitting the API for the rest of the 15 minutes.
    const stream = printStream({ shp_1: 3_000 });
    const controller = new AbortController();
    let calls = 0;

    const result = await awaitPrintConfirmation({
      ids: ["shp_1", "shp_2"],
      ...timing,
      now: stream.now,
      sleep: async (ms: number) => {
        await stream.sleep(ms);
        if (stream.now() >= 6_000) controller.abort();
      },
      fetchPrinted: async (wanted: string[]) => {
        calls += 1;
        return stream.fetchPrinted(wanted);
      },
      signal: controller.signal,
    });

    expect(calls).toBe(2);
    expect(result).toEqual({ printed: ["shp_1"], unconfirmed: ["shp_2"] });
  });
});
