// The Pick & Print grouping invariants (see components/picklist.ts). These
// pin the two facts the popup's safety rests on: a stack row only ever pools
// boxes whose labels are interchangeable, and the label counts the operator
// reads are parcel counts, not unit counts.

import { describe, expect, it } from "vitest";
import {
  attachedIds,
  autoPrintWhen,
  autoReleaseAt,
  awaitPrintConfirmation,
  batchesToPoll,
  BatchSnapshot,
  buildPicklist,
  canPrintAgain,
  clockTime,
  interruptedRow,
  isBusy,
  isPurchasing,
  labelCount,
  picklistRows,
  POLL_STALL_TICKS,
  pollStall,
  PRESTAGE_POLL_MS,
  prestagedEarlier,
  prestagedRow,
  prestageOutcome,
  prestageQueue,
  prestageUnavailable,
  printFailure,
  PRINTER_UNCONFIRMED_REASON,
  progressLabels,
  queueRows,
  readyLabels,
  readyIds,
  readyRows,
  reconcileRow,
  recoveredFailure,
  recoveredRelease,
  recoveredTargets,
  releaseFailedIds,
  resumePoll,
  retrying,
  rowPrintOrder,
  RowState,
  ShipmentSummary,
  unqueueRows,
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

// The waiting row's "12/29" (see picklist-dialog.tsx).
describe("progressLabels", () => {
  // One stack: shp_1 is two boxes, shp_2 one, shp_3 three.
  const [stack] = buildPicklist([
    montaShipment("shp_1", "BAM-01", 2),
    montaShipment("shp_2", "BAM-01", 1),
    montaShipment("shp_3", "BAM-01", 3),
  ]).groups;
  const all = ["shp_1", "shp_2", "shp_3"];

  it("counts labels (boxes), not orders", () => {
    expect(progressLabels(stack.buyable, all, ["shp_1", "shp_3"])).toEqual({
      labels: 6,
      confirmedLabels: 5,
    });
    // A direct-carrier box is one label however many units it holds.
    const [order] = buildPicklist([directShipment("shp_4", "BAM-02", 3)]).mixed;
    expect(progressLabels([order], ["shp_4"], ["shp_4"])).toEqual({
      labels: 1,
      confirmedLabels: 1,
    });
  });

  it("counts over what was bought, not over the whole row", () => {
    // shp_3's purchase failed: it prints nothing, so the count never waits
    // for its three boxes.
    expect(
      progressLabels(stack.buyable, ["shp_1", "shp_2"], ["shp_1"]),
    ).toEqual({ labels: 3, confirmedLabels: 2 });
  });

  it("starts at zero before the printer confirms anything", () => {
    expect(progressLabels(stack.buyable, all, [])).toEqual({
      labels: 6,
      confirmedLabels: 0,
    });
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

    expect(result).toEqual({ printed: ["shp_1"], unconfirmed: ["shp_2"] });
    // shp_1 printed at 3 s, but that read failed: reported on the next one.
    expect(progress).toEqual([[6_000, ["shp_1"]]]);
  });

  it("a listener does not change the result or the timing", async () => {
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

// A popup row's summary as buildPicklist hands it over, reduced to what the
// print-batch helpers read.
const summary = (
  id: string,
  method: string,
  orderLabel: string,
  labels = 1,
): ShipmentSummary => ({
  id,
  method,
  orderLabel,
  own: false,
  units: labels,
  labels,
});

// The order a merged ERP print batch comes out of the printer.
describe("rowPrintOrder", () => {
  it("groups the labels by carrier, alphabetically and case-insensitively", () => {
    const ordered = rowPrintOrder([
      summary("shp_1", "PostNL", "#1001"),
      summary("shp_2", "DHL", "#1002"),
      summary("shp_3", "gls", "#1003"),
      summary("shp_4", "DPD", "#1004"),
      summary("shp_5", "DHL", "#1005"),
    ]);

    expect(ordered.map((s) => s.method)).toEqual([
      "DHL",
      "DHL",
      "DPD",
      "gls",
      "PostNL",
    ]);
  });

  it("orders by order number within a carrier, numeric-aware", () => {
    const ordered = rowPrintOrder([
      summary("shp_1", "DHL", "#1000"),
      summary("shp_2", "DHL", "#999"),
      summary("shp_3", "DHL", "#10000"),
      summary("shp_4", "DHL", "#1001"),
    ]);

    expect(ordered.map((s) => s.orderLabel)).toEqual([
      "#999",
      "#1000",
      "#1001",
      "#10000",
    ]);
  });

  it("keeps the row's own order on a tie", () => {
    // Two colli of one order: same carrier, same order number.
    const ordered = rowPrintOrder([
      summary("shp_b", "DHL", "#1000"),
      summary("shp_a", "DHL", "#1000"),
    ]);

    expect(ordered.map((s) => s.id)).toEqual(["shp_b", "shp_a"]);
  });

  it("follows the popup's carrier columns and leaves the row untouched", () => {
    const shipments = [
      montaShipment("shp_1", "BAM-01", 1, { shipping_method: "PostNL" }),
      montaShipment("shp_2", "BAM-01", 1, { shipping_method: "DHL" }),
      montaShipment("shp_3", "BAM-01", 1, { shipping_method: "GLS" }),
      montaShipment("shp_4", "BAM-01", 1, { shipping_method: "DHL" }),
    ];
    const picklist = buildPicklist(shipments);
    const [stack] = picklist.groups;
    const before = stack.buyable.map((s) => s.id);

    const ordered = rowPrintOrder(stack.buyable);

    expect(Array.from(new Set(ordered.map((s) => s.method)))).toEqual(
      picklist.methods,
    );
    expect(ordered.map((s) => s.id)).toEqual([
      "shp_2",
      "shp_4",
      "shp_3",
      "shp_1",
    ]);
    expect(stack.buyable.map((s) => s.id)).toEqual(before);
  });
});

// Why a row ends red (see picklist-dialog.tsx) — and whether Print again can
// re-send it.
describe("printFailure", () => {
  const row = [
    summary("shp_1", "DHL", "#1", 2),
    summary("shp_2", "DHL", "#2", 1),
    summary("shp_3", "GLS", "#3", 3),
  ];

  it("is nothing when every label was bought and confirmed", () => {
    expect(printFailure(row, [], [], "KPB-1")).toBeNull();
  });

  it("offers a purchase retry over the failed shipments only", () => {
    expect(printFailure(row, ["shp_3"], [])).toEqual({
      reason: "1 purchase(s) failed",
      retryIds: ["shp_3"],
      retryLabels: 3,
      printBatch: null,
      unconfirmedIds: [],
    });
  });

  it("names the silent printer first and keeps the batch to print again", () => {
    expect(printFailure(row, ["shp_3"], ["shp_1"], "KPB-1")).toEqual({
      reason: PRINTER_UNCONFIRMED_REASON,
      retryIds: ["shp_3"],
      retryLabels: 3,
      printBatch: "KPB-1",
      unconfirmedIds: ["shp_1"],
    });
  });

  it("offers Print again only for a batch row whose labels never came out", () => {
    const silentBatch = printFailure(row, [], ["shp_1"], "KPB-1");
    const silentOneByOne = printFailure(row, [], ["shp_1"], null);
    const batchPurchaseOnly = printFailure(row, ["shp_3"], [], "KPB-1");

    expect(silentBatch && canPrintAgain(silentBatch)).toBe(true);
    expect(silentOneByOne && canPrintAgain(silentOneByOne)).toBe(false);
    expect(batchPurchaseOnly && canPrintAgain(batchPurchaseOnly)).toBe(false);
  });
});

// Releasing a print batch is retried (it is idempotent in the ERP).
describe("retrying", () => {
  const flaky = (failures: number) => {
    let calls = 0;
    return {
      calls: () => calls,
      fn: async () => {
        calls += 1;
        if (calls <= failures) throw new Error(`attempt ${calls} failed`);
        return "released";
      },
    };
  };

  it("does not wait when the first attempt lands", async () => {
    const call = flaky(0);
    const pauses: number[] = [];

    const result = await retrying(call.fn, {
      retries: 2,
      delayMs: 2_000,
      sleep: async (ms) => pauses.push(ms),
    });

    expect(result).toBe("released");
    expect(call.calls()).toBe(1);
    expect(pauses).toEqual([]);
  });

  it("sends it again, delayMs apart, until it lands", async () => {
    const call = flaky(2);
    const pauses: number[] = [];

    const result = await retrying(call.fn, {
      retries: 2,
      delayMs: 2_000,
      sleep: async (ms) => pauses.push(ms),
    });

    expect(result).toBe("released");
    expect(call.calls()).toBe(3);
    expect(pauses).toEqual([2_000, 2_000]);
  });

  it("gives up after the retries with the last error", async () => {
    const call = flaky(5);

    await expect(
      retrying(call.fn, { retries: 2, delayMs: 0, sleep: async () => {} }),
    ).rejects.toThrow("attempt 3 failed");
    expect(call.calls()).toBe(3);
  });
});

// "Labels klaarzetten" (btn_prestage_labels): a run buys the popup's rows into
// pre-staged ERP batches without printing them; each row's own Print releases
// its batch later. Everything the popup decides about such a run lives in
// these helpers, so the dialog stays a thin shell around them.

// A shipment the ERP rebuilt after its address review was resolved.
const resolved = <T extends { metadata: Record<string, unknown> }>(
  shipment: T,
): T => ({
  ...shipment,
  metadata: { ...shipment.metadata, address_resolved_at: "2026-11-26T10:00:00" },
});

describe("buildPicklist with resolved addresses", () => {
  const shipments = [
    montaShipment("shp_1", "BAM-01", 1),
    resolved(montaShipment("shp_2", "BAM-01", 1)),
    resolved(directShipment("shp_3", "BAM-01", 2)),
    resolved(montaShipment("shp_4", "BAM-02", 2, { shipping_method: "GLS" })),
  ];

  it("keeps resolved addresses out of the normal stacks, grouped by the same rules", () => {
    const picklist = buildPicklist(shipments, { separateResolved: true });

    expect(picklist.groups.map((g) => [g.sku, g.shipments.map((s) => s.id)])).toEqual([
      ["BAM-01", ["shp_1"]],
    ]);
    expect(picklist.mixed).toEqual([]);
    // The same stacking rule as above: a one-parcel box of two units is
    // packed alone, never pooled into a stack where any label fits any box.
    expect(
      picklist.resolved.groups.map((g) => [g.sku, g.shipments.map((s) => s.id)]),
    ).toEqual([
      ["BAM-01", ["shp_2"]],
      ["BAM-02", ["shp_4"]],
    ]);
    expect(picklist.resolved.mixed.map((m) => m.id)).toEqual(["shp_3"]);
    // One set of carrier columns for both sections.
    expect(picklist.methods).toEqual(["DHL", "GLS", "PostNL"]);
  });

  it("never pools a resolved address into a normal stack of the same SKU", () => {
    const picklist = buildPicklist(shipments, { separateResolved: true });
    const normalIds = [
      ...picklist.groups.flatMap((g) => g.shipments),
      ...picklist.mixed,
    ].map((s) => s.id);

    expect(normalIds).not.toContain("shp_2");
    expect(normalIds).not.toContain("shp_3");
    expect(normalIds).not.toContain("shp_4");
  });

  it("pools them like before when the section is not asked for (pre-staging off)", () => {
    const picklist = buildPicklist(shipments);

    expect(picklist.groups.map((g) => [g.sku, g.shipments.map((s) => s.id)])).toEqual([
      ["BAM-01", ["shp_1", "shp_2"]],
      ["BAM-02", ["shp_4"]],
    ]);
    expect(picklist.mixed.map((m) => m.id)).toEqual(["shp_3"]);
    expect(picklist.resolved).toEqual({ groups: [], mixed: [] });
  });

  it("still reports resolved shipments without order lines", () => {
    const picklist = buildPicklist(
      [resolved({ id: "shp_5", metadata: {}, parcels: [{ items: [] }] })],
      { separateResolved: true },
    );

    expect(picklist.shipmentsWithoutItems).toBe(1);
  });
});

describe("picklistRows", () => {
  const picklist = buildPicklist(
    [
      montaShipment("shp_1", "BAM-02", 2),
      montaShipment("shp_2", "BAM-01", 1),
      montaShipment("shp_3", "BAM-01", 3, { fulfilment_mode: "self_delivery" }),
      directShipment("shp_4", "BAM-03", 3),
      resolved(montaShipment("shp_5", "BAM-01", 1)),
      resolved(directShipment("shp_6", "BAM-04", 2)),
    ],
    { separateResolved: true },
  );

  it("walks the popup top to bottom: stacks, mixed orders, then resolved addresses", () => {
    expect(picklistRows(picklist).map((row) => row.key)).toEqual([
      "sku:BAM-01",
      "sku:BAM-02",
      "order:shp_4",
      "resolved:sku:BAM-01",
      "resolved:order:shp_6",
    ]);
  });

  it("names each row the way the warehouse does: the SKU, or the order number", () => {
    // (These fixtures carry no Shopify order number, so the Karrio id stands
    // in, exactly as in the popup.)
    expect(picklistRows(picklist).map((row) => row.label)).toEqual([
      "BAM-01",
      "BAM-02",
      "shp_4",
      "BAM-01",
      "shp_6",
    ]);
  });

  it("counts boxes as parcels, own delivery included, and buys carrier boxes only", () => {
    const [bam01, bam02, direct] = picklistRows(picklist);

    // shp_2 is one box; shp_3 (own delivery, three per-unit parcels) adds
    // three boxes to pack but buys no label.
    expect(bam01.boxes).toBe(4);
    expect(bam01.targets.map((t) => t.id)).toEqual(["shp_2"]);
    expect(bam02.boxes).toBe(2);
    // Three units in ONE direct-carrier parcel: one box.
    expect(direct.boxes).toBe(1);
  });
});

const idle: RowState = { phase: "idle" };
const ready = (
  batch: string,
  bought: string[],
  failedIds: string[] = [],
  notAttempted: string[] = [],
): RowState => ({ phase: "ready", batch, bought, failedIds, notAttempted });

describe("a pre-stage run", () => {
  const picklist = buildPicklist(
    [
      montaShipment("shp_1", "BAM-01", 1),
      montaShipment("shp_2", "BAM-02", 1),
      montaShipment("shp_3", "BAM-03", 1, { fulfilment_mode: "self_delivery" }),
      directShipment("shp_4", "BAM-04", 2),
      resolved(montaShipment("shp_5", "BAM-01", 1)),
    ],
    { separateResolved: true },
  );
  const rows = picklistRows(picklist);

  it("queues every untouched row with something to buy, in display order", () => {
    const states: Record<string, RowState> = {
      "sku:BAM-02": ready("KPB-1", ["shp_2"]),
    };

    expect(prestageQueue(rows, states).map((row) => row.key)).toEqual([
      "sku:BAM-01",
      "order:shp_4",
      "resolved:sku:BAM-01",
    ]);
  });

  it("leaves rows that were printed, failed or are waiting for the printer alone", () => {
    const states: Record<string, RowState> = {
      "sku:BAM-01": { phase: "printed", labels: 1 },
      "order:shp_4": { phase: "confirming", labels: 1, confirmedLabels: 0 },
      "resolved:sku:BAM-01": {
        phase: "failed",
        reason: "Purchase failed",
        retryIds: ["shp_5"],
        retryLabels: 1,
        printBatch: null,
        unconfirmedIds: [],
      },
    };

    expect(prestageQueue(rows, states).map((row) => row.key)).toEqual([
      "sku:BAM-02",
    ]);
  });

  it("marks the queue and hands it back to idle on Stop, touching nothing else", () => {
    const before: Record<string, RowState> = {
      "sku:BAM-02": ready("KPB-1", ["shp_2"]),
    };
    const queued = queueRows(before, ["sku:BAM-01", "order:shp_4"]);

    expect(queued).toEqual({
      "sku:BAM-02": ready("KPB-1", ["shp_2"]),
      "sku:BAM-01": { phase: "queued" },
      "order:shp_4": { phase: "queued" },
    });
    expect(
      unqueueRows({ ...queued, "sku:BAM-01": { phase: "buying" } }),
    ).toEqual({
      "sku:BAM-02": ready("KPB-1", ["shp_2"]),
      "sku:BAM-01": { phase: "buying" },
      "order:shp_4": idle,
    });
    expect(before).toEqual({ "sku:BAM-02": ready("KPB-1", ["shp_2"]) });
  });

  it("counts as a purchase while it runs; a ready row locks nothing", () => {
    const readyOnly = { "sku:BAM-01": ready("KPB-1", ["shp_1"]) };
    const waiting: Record<string, RowState> = {
      "sku:BAM-01": { phase: "confirming", labels: 1, confirmedLabels: 0 },
    };

    expect(isPurchasing({}, true)).toBe(true);
    expect(isBusy({}, true)).toBe(true);
    expect(isPurchasing(readyOnly, false)).toBe(false);
    expect(isBusy(readyOnly, false)).toBe(false);
    expect(isPurchasing({ x: { phase: "picking" } }, false)).toBe(true);
    expect(isPurchasing({ x: { phase: "queued" } }, false)).toBe(true);
    expect(isPurchasing(waiting, false)).toBe(false);
    expect(isBusy(waiting, false)).toBe(true);
  });
});

describe("prestageOutcome", () => {
  it("is a ready row when the ERP answered prestaged", () => {
    expect(
      prestageOutcome({
        purchased: ["shp_1", "shp_3"],
        failures: ["#2: refused"],
        failedIds: ["shp_2"],
        printBatch: "KPB-1",
        prestaged: true,
        notAttempted: ["shp_4"],
      }),
    ).toEqual({
      kind: "ready",
      row: {
        batch: "KPB-1",
        bought: ["shp_1", "shp_3"],
        failedIds: ["shp_2"],
        notAttempted: ["shp_4"],
      },
    });
  });

  it("adds a retry into the same batch to what the row already bought", () => {
    const previous = {
      batch: "KPB-1",
      bought: ["shp_1"],
      failedIds: ["shp_2"],
      notAttempted: ["shp_3"],
    };

    expect(
      prestageOutcome(
        {
          purchased: ["shp_3"],
          failures: ["#2: refused"],
          failedIds: ["shp_2"],
          printBatch: "KPB-1",
          prestaged: true,
          notAttempted: [],
        },
        previous,
      ),
    ).toEqual({
      kind: "ready",
      row: {
        batch: "KPB-1",
        bought: ["shp_1", "shp_3"],
        failedIds: ["shp_2"],
        notAttempted: [],
      },
    });
  });

  it("is a stopped row when the run stopped before anything was opened or bought", () => {
    expect(
      prestageOutcome({
        purchased: [],
        failures: [],
        failedIds: [],
        printBatch: null,
        prestaged: false,
        notAttempted: ["shp_1", "shp_2"],
      }),
    ).toEqual({ kind: "stopped" });
  });

  it("is a printed-the-normal-way row whenever the ERP did not say prestaged", () => {
    // An ERP that predates pre-staging opens a plain batch (or none): the
    // page released it right after the purchases, as Print always did.
    for (const result of [
      { purchased: ["shp_1"], failures: [], failedIds: [], printBatch: "KPB-1" },
      {
        purchased: ["shp_1"],
        failures: [],
        failedIds: [],
        printBatch: "KPB-1",
        prestaged: false,
        notAttempted: [],
      },
      {
        purchased: [],
        failures: ["#1: refused"],
        failedIds: ["shp_1"],
        printBatch: null,
        prestaged: false,
        notAttempted: [],
      },
    ]) {
      expect(prestageOutcome(result)).toEqual({ kind: "degraded" });
    }
  });

  it("goes on past a row the ERP holds none of: its labels printed on their purchase", () => {
    // Every shipment of the row is one the ERP cannot hold (not ERP-linked,
    // printed before): it answers enabled without a batch. Pre-staging is
    // not unavailable — there was nothing to hold — so the run continues.
    expect(
      prestageOutcome({
        purchased: ["shp_1"],
        failures: [],
        failedIds: [],
        printBatch: null,
        prestaged: false,
        printBatchEnabled: true,
        notAttempted: [],
      }),
    ).toEqual({ kind: "unheld" });
  });

  it("is degraded when the ERP's batches are off, or it opened a batch that is not pre-staged", () => {
    for (const result of [
      {
        purchased: ["shp_1"],
        failures: [],
        failedIds: [],
        printBatch: null,
        prestaged: false,
        printBatchEnabled: false,
        notAttempted: [],
      },
      {
        purchased: ["shp_1"],
        failures: [],
        failedIds: [],
        printBatch: "KPB-1",
        prestaged: false,
        printBatchEnabled: true,
        notAttempted: [],
      },
    ]) {
      expect(prestageOutcome(result)).toEqual({ kind: "degraded" });
    }
  });

  it("closes a batch a Stop left empty: nothing bought, nothing to hold for 120 minutes", () => {
    expect(
      prestageOutcome({
        purchased: [],
        failures: ["#1: refused"],
        failedIds: ["shp_1"],
        printBatch: "KPB-1",
        prestaged: true,
        printBatchEnabled: true,
        notAttempted: ["shp_2", "shp_3"],
      }),
    ).toEqual({
      kind: "abandoned",
      batch: "KPB-1",
      failedIds: ["shp_1", "shp_2", "shp_3"],
    });
  });

  it("closes an emptied batch over everything the row ever left unbought", () => {
    // A stopped Retry into a batch that never got a label.
    expect(
      prestageOutcome(
        {
          purchased: [],
          failures: [],
          failedIds: [],
          printBatch: "KPB-1",
          prestaged: true,
          notAttempted: ["shp_1"],
        },
        { batch: "KPB-1", bought: [], failedIds: ["shp_1"], notAttempted: ["shp_2"] },
      ),
    ).toEqual({
      kind: "abandoned",
      batch: "KPB-1",
      failedIds: ["shp_1", "shp_2"],
    });
  });

  it("keeps a stopped batch that holds labels bought earlier", () => {
    expect(
      prestageOutcome(
        {
          purchased: [],
          failures: [],
          failedIds: [],
          printBatch: "KPB-1",
          prestaged: true,
          notAttempted: ["shp_2"],
        },
        { batch: "KPB-1", bought: ["shp_1"], failedIds: ["shp_2"], notAttempted: [] },
      ),
    ).toEqual({
      kind: "ready",
      row: {
        batch: "KPB-1",
        bought: ["shp_1"],
        failedIds: [],
        notAttempted: ["shp_2"],
      },
    });
  });

  it("keeps a row whose every purchase failed without a Stop: Retry buys into its batch", () => {
    expect(
      prestageOutcome({
        purchased: [],
        failures: ["#1: refused"],
        failedIds: ["shp_1"],
        printBatch: "KPB-1",
        prestaged: true,
        notAttempted: [],
      }).kind,
    ).toBe("ready");
  });
});

describe("prestageUnavailable", () => {
  it("is unavailable when the ERP's batches are off or its batch is not pre-staged", () => {
    expect(prestageUnavailable({ enabled: false, batch: null, prestaged: false })).toBe(true);
    expect(prestageUnavailable({ enabled: true, batch: "KPB-1", prestaged: false })).toBe(true);
    // An ERP that predates pre-staging does not answer the key at all.
    expect(prestageUnavailable({ enabled: true, batch: "KPB-1" })).toBe(true);
  });

  it("is available when the batch is pre-staged, or there was nothing to hold", () => {
    expect(prestageUnavailable({ enabled: true, batch: "KPB-1", prestaged: true })).toBe(false);
    expect(prestageUnavailable({ enabled: true, batch: null, prestaged: false })).toBe(false);
  });
});

describe("prestagedRow / interruptedRow", () => {
  const targets = [
    summary("shp_1", "DHL", "#1"),
    summary("shp_2", "DHL", "#2"),
    summary("shp_3", "DHL", "#3"),
  ];

  it("never lists a shipment as bought twice", () => {
    expect(
      prestagedRow(
        "KPB-1",
        { purchased: ["shp_1", "shp_2"], failedIds: [] },
        { batch: "KPB-1", bought: ["shp_1"], failedIds: [], notAttempted: [] },
      ).bought,
    ).toEqual(["shp_1", "shp_2"]);
  });

  it("keeps the batch of a row whose run broke off, with what is left to buy", () => {
    // Never Open-and-forgotten: the row stays ready over its batch.
    expect(
      interruptedRow(
        { batch: "KPB-1", bought: ["shp_1"], failedIds: ["shp_2"] },
        targets,
      ),
    ).toEqual({
      batch: "KPB-1",
      bought: ["shp_1"],
      failedIds: ["shp_2"],
      notAttempted: ["shp_3"],
    });
    expect(interruptedRow(undefined, targets)).toBeNull();
  });
});

describe("releaseFailedIds", () => {
  it("tells the ERP to stop waiting for failed and never-attempted purchases", () => {
    expect(
      releaseFailedIds({
        failedIds: ["shp_2", "shp_4"],
        notAttempted: ["shp_4", "shp_5"],
      }),
    ).toEqual(["shp_2", "shp_4", "shp_5"]);
    expect(releaseFailedIds({ failedIds: [], notAttempted: [] })).toEqual([]);
  });
});

describe("readyLabels", () => {
  const targets = [
    summary("shp_1", "DHL", "#1", 2),
    summary("shp_2", "DHL", "#2", 1),
    summary("shp_3", "DHL", "#3", 3),
  ];

  it("counts attached labels (boxes) over the labels bought", () => {
    expect(readyLabels(targets, ["shp_1", "shp_2"], ["shp_1"])).toEqual({
      labels: 3,
      attachedLabels: 2,
    });
  });

  it("says unknown when the ERP's status could not be read", () => {
    expect(readyLabels(targets, ["shp_1"], null)).toEqual({
      labels: 2,
      attachedLabels: null,
    });
  });
});

const snapshot = (
  batch: string,
  status: string,
  items: Array<[string, boolean]> = [],
  extra: Partial<BatchSnapshot> = {},
): BatchSnapshot => ({
  batch,
  status,
  total: items.length,
  attached: items.filter(([, attached]) => attached).length,
  items: items.map(([karrio_shipment_id, label_attached]) => ({
    karrio_shipment_id,
    label_attached,
  })),
  ...extra,
});

describe("attachedIds", () => {
  it("lists the shipments whose label the ERP holds", () => {
    expect(
      attachedIds(snapshot("KPB-1", "Open", [["shp_1", true], ["shp_2", false]])),
    ).toEqual(["shp_1"]);
  });

  it("is unknown for a failed poll, an unknown batch or no answer yet", () => {
    expect(attachedIds(null)).toBeNull();
    expect(attachedIds(undefined)).toBeNull();
    expect(attachedIds(snapshot("KPB-1", "Unknown"))).toBeNull();
  });
});

describe("readyIds", () => {
  it("counts a bought label the batch does not hold as ready: it printed on its own", () => {
    // The ERP leaves shipments it cannot hold (not ERP-linked, printed
    // before) out of the batch; their labels print on their purchase.
    expect(
      readyIds(snapshot("KPB-1", "Open", [["shp_1", true], ["shp_2", false]]), [
        "shp_1",
        "shp_2",
        "shp_3",
      ]),
    ).toEqual(["shp_1", "shp_3"]);
  });

  it("is unknown while the batch's status is", () => {
    expect(readyIds(undefined, ["shp_1"])).toBeNull();
    expect(readyIds(snapshot("KPB-1", "Unknown"), ["shp_1"])).toBeNull();
  });
});

describe("batchesToPoll", () => {
  it("polls rows being bought and ready rows still missing labels — nothing else", () => {
    const states: Record<string, RowState> = {
      a: {
        phase: "buying",
        progress: { batch: "KPB-1", bought: [], failedIds: [], total: 3 },
      },
      b: { phase: "buying" },
      c: ready("KPB-2", ["shp_1", "shp_2"]),
      d: ready("KPB-3", ["shp_3"]),
      e: ready("KPB-4", ["shp_4"]),
      f: { phase: "printed", labels: 1 },
    };
    const snapshots = {
      "KPB-2": snapshot("KPB-2", "Open", [["shp_1", true], ["shp_2", false]]),
      "KPB-3": snapshot("KPB-3", "Open", [["shp_3", true]]),
      "KPB-4": null,
    };

    expect(batchesToPoll(states, snapshots)).toEqual(["KPB-1", "KPB-2", "KPB-4"]);
  });

  it("polls a previously pre-staged batch while it is open and incomplete, or on its way to the printer", () => {
    // Queued and Printing move on by themselves to Printed or Failed; the
    // row follows them there. Open and complete waits for its Print.
    const snapshots = {
      "KPB-7": snapshot("KPB-7", "Open", [["shp_7", false]]),
      "KPB-8": snapshot("KPB-8", "Open", [["shp_8", true]]),
      "KPB-9": snapshot("KPB-9", "Queued", [["shp_9", false]]),
      "KPB-10": snapshot("KPB-10", "Printing", [["shp_10", true]]),
      "KPB-11": snapshot("KPB-11", "Printed", [["shp_11", true]]),
      "KPB-12": snapshot("KPB-12", "Failed", [["shp_12", true]]),
      "KPB-13": snapshot("KPB-13", "Partially Printed", [["shp_13", true]]),
    };

    expect(
      batchesToPoll({}, snapshots, Object.keys(snapshots)),
    ).toEqual(["KPB-7", "KPB-9", "KPB-10"]);
  });

  it("pauses a batch that has not changed for two minutes, until the operator acts on its row", () => {
    const states = { a: ready("KPB-1", ["shp_1"]) };
    const snapshots = { "KPB-1": snapshot("KPB-1", "Open", [["shp_1", false]]) };

    expect(POLL_STALL_TICKS * PRESTAGE_POLL_MS).toBe(120_000);
    expect(
      batchesToPoll(states, snapshots, [], { "KPB-1": POLL_STALL_TICKS - 1 }),
    ).toEqual(["KPB-1"]);
    expect(
      batchesToPoll(states, snapshots, [], { "KPB-1": POLL_STALL_TICKS }),
    ).toEqual([]);
    expect(
      batchesToPoll(
        states,
        snapshots,
        [],
        resumePoll({ "KPB-1": POLL_STALL_TICKS }, "KPB-1"),
      ),
    ).toEqual(["KPB-1"]);
  });

  it("is empty when there is nothing to watch, so the poll stops", () => {
    expect(batchesToPoll({ a: idle }, {})).toEqual([]);
  });

  it("stops polling a ready row once every label it holds is attached", () => {
    // shp_9 was bought but never held (printed on its own): nothing to wait for.
    const states = { a: ready("KPB-1", ["shp_1", "shp_9"]) };
    const snapshots = { "KPB-1": snapshot("KPB-1", "Open", [["shp_1", true]]) };

    expect(batchesToPoll(states, snapshots)).toEqual([]);
  });
});

describe("pollStall", () => {
  it("counts the polls in which a batch did not change and starts over when it does", () => {
    const before = {
      "KPB-1": snapshot("KPB-1", "Open", [["shp_1", false]]),
      "KPB-2": snapshot("KPB-2", "Open", [["shp_2", false]]),
    };
    const after = {
      ...before,
      "KPB-1": snapshot("KPB-1", "Open", [["shp_1", false]]),
      "KPB-2": snapshot("KPB-2", "Open", [["shp_2", true]]),
    };

    // KPB-3 was not polled this time: its count stays.
    expect(
      pollStall({ "KPB-1": 3, "KPB-2": 5, "KPB-3": 7 }, ["KPB-1", "KPB-2"], before, after),
    ).toEqual({ "KPB-1": 4, "KPB-2": 0, "KPB-3": 7 });
  });

  it("counts a failed poll as one that brought nothing new", () => {
    const before = { "KPB-1": snapshot("KPB-1", "Open", [["shp_1", false]]) };

    expect(pollStall({}, ["KPB-1"], before, before)).toEqual({ "KPB-1": 1 });
    expect(pollStall({ "KPB-2": 2 }, ["KPB-2"], {}, {})).toEqual({ "KPB-2": 3 });
  });

  it("sees a change in an item's print state as a change", () => {
    const before = {
      "KPB-1": {
        batch: "KPB-1",
        status: "Printing",
        items: [{ karrio_shipment_id: "shp_1", label_attached: true, state: "Waiting" }],
      },
    };
    const after = {
      "KPB-1": {
        batch: "KPB-1",
        status: "Printing",
        items: [{ karrio_shipment_id: "shp_1", label_attached: true, state: "Printed" }],
      },
    };

    expect(pollStall({ "KPB-1": 9 }, ["KPB-1"], before, after)).toEqual({ "KPB-1": 0 });
  });
});

describe("reconcileRow", () => {
  it("counts a purchase the popup saw fail as bought once the batch holds its label", () => {
    // Timed out in the browser, went through at Karrio: released as failed,
    // the ERP would skip it and nothing would ever print it.
    const row = {
      batch: "KPB-1",
      bought: ["shp_1"],
      failedIds: ["shp_2", "shp_3"],
      notAttempted: ["shp_4"],
    };
    const latest = snapshot("KPB-1", "Open", [
      ["shp_1", true],
      ["shp_2", true],
      ["shp_3", false],
      ["shp_4", true],
    ]);

    const reconciled = reconcileRow(row, latest);

    expect(reconciled).toEqual({
      batch: "KPB-1",
      bought: ["shp_1", "shp_2", "shp_4"],
      failedIds: ["shp_3"],
      notAttempted: [],
    });
    expect(releaseFailedIds(reconciled)).toEqual(["shp_3"]);
    // The row it was given is left as it was.
    expect(row.failedIds).toEqual(["shp_2", "shp_3"]);
  });

  it("leaves the row as the popup saw it while the batch's status is unknown", () => {
    const row = {
      batch: "KPB-1",
      bought: ["shp_1"],
      failedIds: ["shp_2"],
      notAttempted: [],
    };

    expect(reconcileRow(row, undefined)).toEqual(row);
    expect(reconcileRow(row, null)).toEqual(row);
    expect(reconcileRow(row, snapshot("KPB-1", "Unknown"))).toEqual(row);
  });
});

describe("recoveredRelease", () => {
  it("prints what has a label and tells the ERP to stop waiting for the rest", () => {
    expect(
      recoveredRelease(
        snapshot("KPB-1", "Open", [
          ["shp_1", true],
          ["shp_2", false],
          ["shp_3", true],
        ]),
      ),
    ).toEqual({ bought: ["shp_1", "shp_3"], failedIds: ["shp_2"] });
  });
});

describe("recoveredTargets / recoveredFailure", () => {
  it("counts a batch found again after a reload per shipment", () => {
    // The ERP names shipments, not parcels: one label each is all the popup
    // can say about rows that are no longer on its list.
    expect(
      recoveredTargets(snapshot("KPB-1", "Open", [["shp_1", true], ["shp_2", false]])),
    ).toEqual([
      { id: "shp_1", orderLabel: "shp_1", method: "", own: false, units: 1, labels: 1 },
      { id: "shp_2", orderLabel: "shp_2", method: "", own: false, units: 1, labels: 1 },
    ]);
  });

  it("offers Print again over the labels a finished batch did not print", () => {
    const batch: BatchSnapshot = {
      batch: "KPB-1",
      status: "Partially Printed",
      items: [
        { karrio_shipment_id: "shp_1", label_attached: true, state: "Printed" },
        { karrio_shipment_id: "shp_2", label_attached: true, state: "Failed" },
        { karrio_shipment_id: "shp_3", label_attached: false, state: "Skipped" },
      ],
    };

    expect(recoveredFailure(batch)).toEqual({
      reason: PRINTER_UNCONFIRMED_REASON,
      retryIds: [],
      retryLabels: 0,
      printBatch: "KPB-1",
      unconfirmedIds: ["shp_2"],
    });
    expect(recoveredFailure({ ...batch, status: "Failed" })?.unconfirmedIds).toEqual([
      "shp_2",
    ]);
  });

  it("has no failure for a batch that is open, on its way or printed", () => {
    for (const status of ["Open", "Queued", "Printing", "Printed", "Unknown"]) {
      expect(
        recoveredFailure(snapshot("KPB-1", status, [["shp_1", true]])),
      ).toBeNull();
    }
  });
});

describe("closing over pre-staged rows", () => {
  const states: Record<string, RowState> = {
    a: ready("KPB-1", ["shp_1"]),
    b: ready("KPB-2", ["shp_2"]),
    c: { phase: "printed", labels: 1 },
  };

  it("names the ready rows", () => {
    expect(readyRows(states).map((row) => row.batch)).toEqual(["KPB-1", "KPB-2"]);
  });

  it("gives the earliest automatic release among them", () => {
    const snapshots = {
      "KPB-1": snapshot("KPB-1", "Open", [], {
        auto_release_at: "2026-11-26T16:40:00",
      }),
      "KPB-2": snapshot("KPB-2", "Open", [], {
        auto_release_at: "2026-11-26T16:05:00",
      }),
      "KPB-3": snapshot("KPB-3", "Open", [], {
        auto_release_at: "2026-11-26T15:00:00",
      }),
    };

    expect(autoReleaseAt(["KPB-1", "KPB-2"], snapshots)).toBe(
      "2026-11-26T16:05:00",
    );
    expect(autoReleaseAt(["KPB-1"], {})).toBeNull();
  });
});

describe("clockTime", () => {
  it("reads the ERP's local time as the warehouse clock", () => {
    expect(clockTime("2026-11-26T16:05:00")).toBe("16:05");
    expect(clockTime("2026-11-26 09:30:12")).toBe("09:30");
  });

  it("converts an instant with an offset to the given zone", () => {
    expect(clockTime("2026-11-26T15:05:00Z", "Europe/Amsterdam")).toBe("16:05");
  });

  it("has nothing to say about a missing or broken time", () => {
    expect(clockTime(null)).toBeNull();
    expect(clockTime("soon")).toBeNull();
  });
});

describe("autoPrintWhen", () => {
  const at = "2026-11-26 16:05:00";
  const time = new Date("2026-11-26T16:05:00").getTime();

  it("names the time the ERP prints a held batch by itself", () => {
    expect(autoPrintWhen(at, time - 60_000)).toBe("at 16:05");
  });

  it("never names a time that has passed", () => {
    expect(autoPrintWhen(at, time)).toBe("any moment now");
    expect(autoPrintWhen(at, time + 60 * 60_000)).toBe("any moment now");
  });

  it("has nothing to say when the ERP did not", () => {
    expect(autoPrintWhen(null, time)).toBeNull();
    expect(autoPrintWhen("soon", time)).toBeNull();
  });
});

describe("prestagedEarlier", () => {
  it("counts only open batches as waiting to be printed", () => {
    const batches: BatchSnapshot[] = [
      snapshot("KPB-1", "Open", [["shp_1", true]]),
      snapshot("KPB-2", "Queued", [["shp_2", true]]),
      snapshot("KPB-3", "Printing", [["shp_3", true]]),
      {
        batch: "KPB-4",
        status: "Failed",
        items: [{ karrio_shipment_id: "shp_4", label_attached: true, state: "Failed" }],
      },
      {
        batch: "KPB-5",
        status: "Partially Printed",
        items: [{ karrio_shipment_id: "shp_5", label_attached: true, state: "Printed" }],
      },
    ];

    // KPB-4 did not print a label it holds: Print again needs the operator.
    // KPB-5 printed everything it held; KPB-2/3 are on their way.
    expect(prestagedEarlier(batches)).toEqual({ waiting: 1, unprinted: 1 });
  });

  it("finds nothing in an empty list", () => {
    expect(prestagedEarlier([])).toEqual({ waiting: 0, unprinted: 0 });
  });
});
