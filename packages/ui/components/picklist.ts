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

export interface PicklistSection {
  groups: SkuGroup[];
  mixed: MixedOrder[];
}

export interface Picklist extends PicklistSection {
  methods: string[];
  // Fail-visible: rows without order lines cannot be aggregated, and a pick
  // list that silently omits them would read as "nothing to pick" for
  // exactly the orders that need attention.
  shipmentsWithoutItems: number;
  // Orders whose address review was resolved (see ADDRESS_RESOLVED_KEY):
  // their own section, packed last, grouped by the same rules. Empty unless
  // buildPicklist was asked to separate them.
  resolved: PicklistSection;
}

export interface BuyResult {
  purchased: string[];
  failures: string[];
  failedIds: string[];
  // The ERP print batch the row's labels were held in (see rowPrintOrder),
  // or null/absent when they printed one by one on their purchase webhook —
  // the btn_print_batch flag is off, or opening the batch failed.
  printBatch?: string | null;
  // Pre-staging only (BuyOptions.prestage): true when the ERP holds the
  // row's labels in a pre-staged batch the page did NOT release — the row's
  // own Print does that later. Anything else was released (or printed one
  // by one) the moment the purchases were done, exactly as Print does.
  prestaged?: boolean;
  // Pre-staging only: the ERP's print batches were on when the row's batch
  // was asked for (its answer's `enabled`). Without a batch that means the
  // ERP holds none of the row's shipments — they print on their purchase —
  // not that pre-staging is unavailable (see prestageUnavailable).
  printBatchEnabled?: boolean;
  // Pre-staging only: the shipments a Stop left unbought.
  notAttempted?: string[];
}

// What the page reports back while it runs one row's purchase: with ERP
// print batches on, the row's picks are recorded upfront (picking) before
// the sequential purchases start (buying). Without them it never calls.
export type BuyPhase = "picking" | "buying";

// Where a pre-staged row's purchases stand: reported after its batch opened
// and after every purchase, so a Stop — or a run that breaks off — never
// loses track of the batch (see interruptedRow).
export interface PurchaseProgress {
  batch: string | null;
  bought: string[];
  failedIds: string[];
}

// A row bought into a pre-staged ERP batch and not printed yet: the ERP holds
// its labels until the row's Print releases the batch (or its own safety net
// does, hours later). failedIds are purchases that failed, notAttempted the
// ones a Stop never reached — both are what Retry buys into the same batch.
export interface PrestagedRow {
  batch: string;
  bought: string[];
  failedIds: string[];
  notAttempted: string[];
}

// Pre-staging asks the page for a little more than a plain Print.
export interface PrestageRequest {
  // The row's name in the ERP batch: what the popup shows for it after a
  // reload ("previously pre-staged").
  rowLabel: string;
  // Retry before Print: buy into this open pre-staged batch instead of
  // picking and opening a new one.
  batch?: string | null;
  // Asked before every purchase. A Stop ends the row after the purchase in
  // flight; what is left comes back as notAttempted.
  shouldStop: () => boolean;
  onProgress: (progress: PurchaseProgress) => void;
}

export interface BuyOptions {
  // The row's ids in the order its labels should come out of the printer
  // (rowPrintOrder) — used by the page only when it prints the row as one
  // ERP print batch; the one-by-one path keeps the row's own order.
  printOrder: string[];
  onPhase: (phase: BuyPhase) => void;
  // Absent: the row prints as soon as it is bought, as always.
  prestage?: PrestageRequest;
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

// The waiting row's "12/29": labels (boxes), not orders, and over what was
// bought — a failed purchase prints nothing, so the count never waits for it.
export const progressLabels = (
  targets: ShipmentSummary[],
  purchased: string[],
  printed: string[],
): { labels: number; confirmedLabels: number } => {
  const bought = targets.filter((target) => purchased.includes(target.id));
  return {
    labels: labelCount(bought),
    confirmedLabels: labelCount(
      bought.filter((shipment) => printed.includes(shipment.id)),
    ),
  };
};

// Stamped by the ERP on the draft that replaced one whose address review was
// resolved. Those orders turn up after the rest of the day's list was walked,
// so with pre-staging on the popup packs them in a section of their own, last.
export const ADDRESS_RESOLVED_KEY = "address_resolved_at";

const isResolvedAddress = (shipment: PicklistShipmentLike): boolean =>
  Boolean(metadataOf(shipment)[ADDRESS_RESOLVED_KEY]);

export function buildPicklist(
  shipments: PicklistShipmentLike[],
  // separateResolved: pre-staging only. Off, every order is grouped together
  // exactly as before the section existed.
  { separateResolved = false }: { separateResolved?: boolean } = {},
): Picklist {
  const packedLast = (shipment: PicklistShipmentLike) =>
    separateResolved && isResolvedAddress(shipment);
  const main = groupSection(shipments.filter((shipment) => !packedLast(shipment)));
  const late = groupSection(shipments.filter(packedLast));

  return {
    groups: main.groups,
    mixed: main.mixed,
    methods: Array.from(new Set([...main.methods, ...late.methods])).sort(
      compareMethods,
    ),
    shipmentsWithoutItems: main.shipmentsWithoutItems + late.shipmentsWithoutItems,
    resolved: { groups: late.groups, mixed: late.mixed },
  };
}

function groupSection(
  shipments: PicklistShipmentLike[],
): PicklistSection & { methods: string[]; shipmentsWithoutItems: number } {
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
    methods: Array.from(methods),
    shipmentsWithoutItems,
  };
}

// One popup row as the dialog walks it, top to bottom.
export interface PicklistRow {
  key: string;
  // The row's name in an ERP print batch: the stack's SKU or the order
  // number — what the warehouse calls the row.
  label: string;
  // What Print buys: carrier shipments only (own delivery is pick-only).
  targets: ShipmentSummary[];
  // Boxes to pack for the row: every parcel, own delivery included.
  boxes: number;
  resolved: boolean;
}

// Frappe's Data field that keeps the row's name on the ERP batch.
const ROW_LABEL_MAX_LENGTH = 140;

export const stackKey = (sku: string, resolved = false): string =>
  `${resolved ? "resolved:" : ""}sku:${sku}`;
export const orderKey = (id: string, resolved = false): string =>
  `${resolved ? "resolved:" : ""}order:${id}`;

// The popup's rows in display order: SKU stacks, mixed orders, then the
// resolved-address section (its stacks, then its orders). A "pre-stage
// labels" run walks them in exactly this order.
export function picklistRows(picklist: Picklist): PicklistRow[] {
  const section = (
    { groups, mixed }: PicklistSection,
    resolved: boolean,
  ): PicklistRow[] => [
    ...groups.map((group) => ({
      key: stackKey(group.sku, resolved),
      label: group.sku.slice(0, ROW_LABEL_MAX_LENGTH),
      targets: group.buyable,
      boxes: labelCount(group.shipments),
      resolved,
    })),
    ...mixed.map((order) => ({
      key: orderKey(order.id, resolved),
      label: order.orderLabel.slice(0, ROW_LABEL_MAX_LENGTH),
      targets: order.own ? [] : [order],
      boxes: order.labels,
      resolved,
    })),
  ];
  return [...section(picklist, false), ...section(picklist.resolved, true)];
}

// The popup's column order, shared with rowPrintOrder so a merged print comes
// out in the order the picker reads the columns. Own delivery closes the
// walk: the van is loaded after the parcels.
function compareMethods(a: string, b: string): number {
  return a === OWN_DELIVERY_METHOD
    ? 1
    : b === OWN_DELIVERY_METHOD
      ? -1
      : a.localeCompare(b);
}

// The order one row's labels come out of the printer when they are printed as
// ONE merged job (the ERP print batch). Printed one by one, labels of a mixed
// row came out interleaved — DHL, PostNL, DHL, GLS — and the picker sorted the
// sheets by carrier by hand before sticking them. Grouped by method (the
// popup's column order), then by order number, numeric-aware so #999 comes
// before #1000. Stable: ties keep the row's own order. Purchases run in this
// order too, and the ERP merges in the order the batch was opened with.
export const rowPrintOrder = (targets: ShipmentSummary[]): ShipmentSummary[] =>
  [...targets].sort(
    (a, b) =>
      compareMethods(a.method, b.method) ||
      a.orderLabel.localeCompare(b.orderLabel, undefined, { numeric: true }),
  );

// Why a row ended red, or null when it is green: every purchase landed and
// the printer confirmed every bought label. retryIds are the shipments that
// still need a label (the purchase Retry); unconfirmedIds were bought but the
// printer never confirmed them — the ones Print again waits for, which it can
// only ask for when the row was printed as an ERP print batch.
export interface PrintFailure {
  reason: string;
  retryIds: string[];
  retryLabels: number;
  printBatch: string | null;
  unconfirmedIds: string[];
}

export const PRINTER_UNCONFIRMED_REASON =
  "Printer did not confirm — check PrintNode, or use Open label PDFs";

export function printFailure(
  targets: ShipmentSummary[],
  failedIds: string[],
  unconfirmed: string[],
  printBatch?: string | null,
): PrintFailure | null {
  if (failedIds.length + unconfirmed.length === 0) return null;
  const retrySummaries = targets.filter((t) => failedIds.includes(t.id));
  return {
    // The printer's silence wins the headline: a failed purchase is plain to
    // see (its Retry button), a label that never came out is not.
    reason:
      unconfirmed.length > 0
        ? PRINTER_UNCONFIRMED_REASON
        : `${failedIds.length} purchase(s) failed`,
    retryIds: retrySummaries.map((t) => t.id),
    retryLabels: labelCount(retrySummaries),
    printBatch: printBatch ?? null,
    unconfirmedIds: unconfirmed,
  };
}

// Print again re-sends the row's merged job from the ERP; a row whose labels
// printed one by one has no job to re-send (Open label PDFs covers it).
export const canPrintAgain = (failure: {
  printBatch?: string | null;
  unconfirmedIds?: string[];
}): boolean =>
  Boolean(failure.printBatch) && (failure.unconfirmedIds || []).length > 0;

// Runs `fn`, and on a rejection up to `retries` more times, `delayMs` apart;
// the last rejection is what the caller sees. For calls that are idempotent
// on the other end (releasing a print batch) — nothing else belongs here.
export async function retrying<T>(
  fn: () => Promise<T>,
  {
    retries,
    delayMs,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }: {
    retries: number;
    delayMs: number;
    sleep?: (ms: number) => Promise<unknown>;
  },
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleep(delayMs);
    }
  }
}

// The popup's green tick: poll until the ERP has mirrored printed_at on every
// bought shipment, or give up. The ERP confirms ONE label at a time (purchase
// webhook → auto-print → PrintNode "done" → stamp → mirror, ~6 s a label)
// while a purchase takes ~3 s, so on a big stack the confirmations trail the
// last purchase by well over a minute — 23-09: one 28-box stack, the last
// four confirmed 98–108 s after their purchase and a fixed 90 s window
// turned a fully printed row red. The window therefore slides: it is the
// longest the printer may stay SILENT, restarted by every new confirmation,
// not a budget for the whole row. A dead printer or PrintNode still turns
// the row red one idle window after its last sign of life.
//
// The popup cannot be closed while a row waits for the printer, so a hard
// ceiling (maxWaitMs, counted from the start) bounds that lock even when
// confirmations keep trickling in just inside the idle window.
//
// onProgress feeds the row's "Waiting for printer… 12/29": a big stack waits
// for minutes, and a bare spinner reads like a hung printer.
export async function awaitPrintConfirmation({
  ids,
  fetchPrinted,
  idleTimeoutMs,
  maxWaitMs,
  pollMs,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onProgress,
  signal,
}: {
  ids: string[];
  // The subset of `wanted` whose printed_at is mirrored. May throw: a
  // transient read failure keeps the poll going — the verdict is the
  // printer's, not the network's.
  fetchPrinted: (wanted: string[]) => Promise<string[]>;
  idleTimeoutMs: number;
  maxWaitMs: number;
  pollMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  // Every id confirmed so far, called only after a tick that confirmed new
  // ones — never on a silent tick, never after the verdict.
  onProgress?: (printed: string[]) => void;
  // Aborted when the popup unmounts: stop polling for a row nobody sees.
  // The rest then comes back as unconfirmed — not a verdict; only the
  // unmounted popup reads it.
  signal?: AbortSignal;
}): Promise<PrintConfirmation> {
  const pending = new Set(ids);
  const printed: string[] = [];
  const hardStop = now() + maxWaitMs;
  let deadline = now() + idleTimeoutMs;
  while (pending.size > 0 && !signal?.aborted) {
    try {
      const confirmed = await fetchPrinted(Array.from(pending));
      const fresh = confirmed.filter((id) => pending.has(id));
      if (fresh.length > 0) {
        fresh.forEach((id) => pending.delete(id));
        printed.push(...fresh);
        deadline = now() + idleTimeoutMs;
        // Inside the try on purpose: a listener that throws is swallowed
        // like a failed read — the display must never break the verdict.
        onProgress?.([...printed]);
      }
    } catch {
      // Keep polling until the (idle) deadline.
    }
    const time = now();
    if (pending.size === 0 || time >= deadline || time >= hardStop) break;
    await sleep(pollMs);
  }
  return { printed, unconfirmed: Array.from(pending) };
}

// --------------------------------------------------------------------------
// Pre-staged rows ("Labels klaarzetten", flag btn_prestage_labels)
//
// A run buys the popup's rows one after the other into pre-staged ERP print
// batches and prints nothing: the ERP holds every label until that row's
// Print releases its batch, so the paper comes out in ~10 s next to the
// stack it belongs to. The ERP's batch is the source of truth; the row states
// below are the popup's own view of it, and a reload finds the batches again
// through the ERP (print_batch_status in list mode).
// --------------------------------------------------------------------------

// Grey (idle) → [queued →] [picking →] buying → ready (pre-staged, held in
// the ERP) → waiting for the printer → green (PrintNode confirmed) or red
// (purchase failed / printer never confirmed). Red keeps a Retry over exactly
// the shipments that still need a label, and — for a row printed as an ERP
// print batch — a Print again that re-sends the merged job, with the ERP's
// refusal (printError) shown in the row. While waiting, the row counts the
// labels the printer confirmed so far.
export type RowState =
  | { phase: "idle" }
  | { phase: "queued" }
  | { phase: "picking" }
  | { phase: "buying"; progress?: PurchaseProgress & { total: number } }
  | ({ phase: "ready" } & PrestagedRow)
  | { phase: "confirming"; labels: number; confirmedLabels: number }
  | { phase: "printed"; labels: number }
  | ({ phase: "failed"; printError?: string } & PrintFailure);

const phaseOf = (state?: RowState) => (state ?? { phase: "idle" }).phase;

// Purchases are strictly sequential (Monta's verification window, the ERP's
// row locks): a row picking or buying — or a pre-stage run that will buy the
// next queued row — blocks every other purchase. A ready row buys nothing.
export const isPurchasing = (
  states: Record<string, RowState>,
  running: boolean,
): boolean =>
  running ||
  Object.values(states).some((state) =>
    ["queued", "picking", "buying"].includes(state.phase),
  );

// What keeps the popup open: a purchase, or a row waiting for the printer.
export const isBusy = (
  states: Record<string, RowState>,
  running: boolean,
): boolean =>
  isPurchasing(states, running) ||
  Object.values(states).some((state) => state.phase === "confirming");

// The rows a run walks: every row with something to buy that nothing has
// happened to yet, in display order.
export const prestageQueue = (
  rows: PicklistRow[],
  states: Record<string, RowState>,
): PicklistRow[] =>
  rows.filter(
    (row) => row.targets.length > 0 && phaseOf(states[row.key]) === "idle",
  );

export const queueRows = (
  states: Record<string, RowState>,
  keys: string[],
): Record<string, RowState> => ({
  ...states,
  ...Object.fromEntries(keys.map((key) => [key, { phase: "queued" } as RowState])),
});

// Stop (and the end of every run): rows still waiting their turn go back to
// grey. Whatever was bought stays bought.
export const unqueueRows = (
  states: Record<string, RowState>,
): Record<string, RowState> =>
  Object.fromEntries(
    Object.entries(states).map(([key, state]) => [
      key,
      state.phase === "queued" ? ({ phase: "idle" } as RowState) : state,
    ]),
  );

export const readyRows = (states: Record<string, RowState>): PrestagedRow[] =>
  Object.values(states).flatMap((state) =>
    state.phase === "ready"
      ? [
          {
            batch: state.batch,
            bought: state.bought,
            failedIds: state.failedIds,
            notAttempted: state.notAttempted,
          },
        ]
      : [],
  );

export const prestagedRow = (
  batch: string,
  result: { purchased: string[]; failedIds: string[]; notAttempted?: string[] },
  previous?: PrestagedRow,
): PrestagedRow => ({
  batch,
  bought: Array.from(new Set([...(previous?.bought ?? []), ...result.purchased])),
  failedIds: result.failedIds,
  notAttempted: result.notAttempted ?? [],
});

// Whether the ERP's answer to a pre-staged open means pre-staging is not
// available: its print batches are off (or the open failed), or it opened a
// batch that is not pre-staged (an ERP that predates it, its flag off). An
// enabled answer WITHOUT a batch is not that: the ERP holds none of the
// row's shipments (not ERP-linked, printed before), so there was nothing to
// hold — their labels print on their purchase, as they always did.
export const prestageUnavailable = (opened: {
  enabled: boolean;
  batch: string | null;
  prestaged?: boolean;
}): boolean =>
  !opened.enabled || (Boolean(opened.batch) && opened.prestaged !== true);

// How a pre-stage purchase run ended for its row:
// - ready: the ERP holds the labels in a pre-staged batch;
// - abandoned: a Stop left the pre-staged batch without a single label —
//   release it over all its shipments as failed, so the ERP does not hold an
//   empty batch for two hours, and the row goes back to grey;
// - stopped: Stop came before the batch was opened — nothing bought;
// - unheld: the ERP holds none of the row's shipments; their labels printed
//   on their purchase, the row settles like a plain Print and the run goes on;
// - degraded: the ERP did not pre-stage (prestageUnavailable). The page
//   already released the batch right after the purchases, so the row prints
//   the normal way.
export type PrestageOutcome =
  | { kind: "ready"; row: PrestagedRow }
  | { kind: "abandoned"; batch: string; failedIds: string[] }
  | { kind: "stopped" }
  | { kind: "unheld" }
  | { kind: "degraded" };

export function prestageOutcome(
  result: BuyResult,
  previous?: PrestagedRow,
): PrestageOutcome {
  const notAttempted = result.notAttempted ?? [];
  if (result.prestaged === true && result.printBatch) {
    const row = prestagedRow(result.printBatch, result, previous);
    if (row.bought.length === 0 && notAttempted.length > 0) {
      return {
        kind: "abandoned",
        batch: row.batch,
        failedIds: releaseFailedIds({
          failedIds: [...(previous?.failedIds ?? []), ...row.failedIds],
          notAttempted: [...(previous?.notAttempted ?? []), ...notAttempted],
        }),
      };
    }
    return { kind: "ready", row };
  }
  const nothingHappened =
    !result.printBatch &&
    result.purchased.length === 0 &&
    result.failedIds.length === 0 &&
    notAttempted.length > 0;
  if (nothingHappened) return { kind: "stopped" };
  const unavailable = prestageUnavailable({
    enabled: result.printBatchEnabled === true,
    batch: result.printBatch ?? null,
    prestaged: result.prestaged,
  });
  return unavailable ? { kind: "degraded" } : { kind: "unheld" };
}

// A pre-stage run that broke off with an exception still leaves its batch
// open in the ERP. The last progress report names it, so the row turns ready
// over it instead of being forgotten; null when no pre-staged batch opened.
export function interruptedRow(
  progress: PurchaseProgress | undefined,
  targets: ShipmentSummary[],
): PrestagedRow | null {
  if (!progress?.batch) return null;
  const attempted = new Set([...progress.bought, ...progress.failedIds]);
  return {
    batch: progress.batch,
    bought: progress.bought,
    failedIds: progress.failedIds,
    notAttempted: targets
      .map((target) => target.id)
      .filter((id) => !attempted.has(id)),
  };
}

// What the ERP must stop waiting for when a pre-staged row is printed — and
// what Retry buys into the same batch before that.
export const releaseFailedIds = (
  row: Pick<PrestagedRow, "failedIds" | "notAttempted">,
): string[] => Array.from(new Set([...row.failedIds, ...row.notAttempted]));

// What a print_batch_status answer says about one batch, reduced to what
// the popup reads.
export interface BatchSnapshot {
  batch: string;
  status: string;
  row_label?: string | null;
  auto_release_at?: string | null;
  total?: number;
  attached?: number;
  items?: Array<{
    karrio_shipment_id: string;
    label_attached: boolean;
    // Waiting | Skipped | Printed | Late | Failed
    state?: string;
  }>;
}

// Snapshots by batch name: null when the last poll failed (status unknown),
// absent before the first answer.
export type BatchSnapshots = Record<string, BatchSnapshot | null | undefined>;

// The list of batches pre-staged earlier as the page already asked for it
// (the empty-selection entry), so the popup does not ask again: the answer,
// or that it could not be loaded.
export type RecoveredPreload = { batches: BatchSnapshot[] } | { error: true };

export const attachedIds = (
  snapshot: BatchSnapshot | null | undefined,
): string[] | null =>
  snapshot && snapshot.status !== "Unknown" && Array.isArray(snapshot.items)
    ? snapshot.items
        .filter((item) => item.label_attached)
        .map((item) => item.karrio_shipment_id)
    : null;

// A ready row as the ERP's latest snapshot has it. A purchase the popup saw
// fail — or never saw finish, the run having broken off — can still have
// gone through at Karrio (a browser timeout, "already purchased"); once the
// batch holds its label, that shipment is bought. Released as failed it
// would be skipped and never printed, and a Retry would buy it twice. What
// Print releases, what Retry buys and what the row counts all read the row
// through this. Unchanged while the batch's status is unknown.
export function reconcileRow(
  row: PrestagedRow,
  snapshot: BatchSnapshot | null | undefined,
): PrestagedRow {
  const attached = attachedIds(snapshot);
  if (attached === null) return row;
  const held = (id: string) => attached.includes(id);
  return {
    batch: row.batch,
    bought: Array.from(
      new Set([...row.bought, ...releaseFailedIds(row).filter(held)]),
    ),
    failedIds: row.failedIds.filter((id) => !held(id)),
    notAttempted: row.notAttempted.filter((id) => !held(id)),
  };
}

// What of a ready row's purchases is ready to print: the labels the batch
// holds attached, plus bought shipments the batch never held (not
// ERP-linked, printed before — the ERP prints those on their own purchase,
// so they wait for nothing). Null while the batch's status is unknown.
export const readyIds = (
  snapshot: BatchSnapshot | null | undefined,
  bought: string[],
): string[] | null => {
  const attached = attachedIds(snapshot);
  if (attached === null) return null;
  const held = new Set(
    (snapshot?.items ?? []).map((item) => item.karrio_shipment_id),
  );
  return bought.filter((id) => attached.includes(id) || !held.has(id));
};

// The ready row's "27/29": labels (boxes) the ERP already holds over the
// labels bought; attachedLabels null while the ERP's status is unknown.
export const readyLabels = (
  targets: ShipmentSummary[],
  bought: string[],
  attached: string[] | null,
): { labels: number; attachedLabels: number | null } => {
  const boughtTargets = targets.filter((target) => bought.includes(target.id));
  return {
    labels: labelCount(boughtTargets),
    attachedLabels:
      attached === null
        ? null
        : labelCount(boughtTargets.filter((t) => attached.includes(t.id))),
  };
};

// One status call covers every batch the ERP accepts in one request.
const STATUS_MAX_BATCHES = 50;

// One status poll for every watched batch, every few seconds.
export const PRESTAGE_POLL_MS = 5_000;
// A batch whose answer has not changed for two minutes is paused: labels
// that have not arrived by then are not about to, and a popup left open
// over lunch must not poll the ERP all afternoon. Any action on its row
// resumes it (resumePoll); Print never waits for the poll.
export const POLL_STALL_TICKS = 120_000 / PRESTAGE_POLL_MS;

// Consecutive polls without news, per batch.
export type PollStall = Record<string, number>;

// What of a snapshot the popup reads: a change in any of it is news.
const snapshotSignature = (snapshot: BatchSnapshot | null | undefined): string =>
  JSON.stringify(
    snapshot
      ? [
          snapshot.status,
          snapshot.attached ?? null,
          snapshot.total ?? null,
          (snapshot.items ?? []).map((item) => [
            item.karrio_shipment_id,
            item.label_attached,
            item.state ?? null,
          ]),
        ]
      : null,
  );

// After a poll over `polled`: a batch whose snapshot changed starts over at
// zero, one that did not — or whose poll failed (before === after) — counts
// one more. Batches not polled keep their count.
export function pollStall(
  stall: PollStall,
  polled: string[],
  before: BatchSnapshots,
  after: BatchSnapshots,
): PollStall {
  return {
    ...stall,
    ...Object.fromEntries(
      polled.map((name) => [
        name,
        snapshotSignature(before[name]) === snapshotSignature(after[name])
          ? (stall[name] ?? 0) + 1
          : 0,
      ]),
    ),
  };
}

export const resumePoll = (stall: PollStall, batch: string): PollStall => ({
  ...stall,
  [batch]: 0,
});

export const isPollPaused = (stall: PollStall, batch: string): boolean =>
  (stall[batch] ?? 0) >= POLL_STALL_TICKS;

// The batches worth a status poll: rows being bought into a pre-staged
// batch, ready rows whose labels are not all attached yet (or unknown), and
// previously pre-staged batches still open and incomplete or on their way to
// the printer (Queued, Printing — until Printed or Failed). Paused batches
// are left out (POLL_STALL_TICKS). Empty → no poll.
export function batchesToPoll(
  states: Record<string, RowState>,
  snapshots: BatchSnapshots,
  recovered: string[] = [],
  stall: PollStall = {},
): string[] {
  const rows = Object.values(states).flatMap((state) => {
    if (state.phase === "buying") {
      return state.progress?.batch ? [state.progress.batch] : [];
    }
    if (state.phase !== "ready") return [];
    const done = readyIds(snapshots[state.batch], state.bought);
    return done && done.length === state.bought.length ? [] : [state.batch];
  });
  const earlier = recovered.filter((name) => {
    const snapshot = snapshots[name];
    if (snapshot?.status === "Queued" || snapshot?.status === "Printing") {
      return true;
    }
    return (
      snapshot?.status === "Open" && (snapshot.attached ?? 0) < (snapshot.total ?? 0)
    );
  });
  return Array.from(new Set([...rows, ...earlier]))
    .filter((name) => !isPollPaused(stall, name))
    .slice(0, STATUS_MAX_BATCHES);
}

// Print on a previously pre-staged batch: the same rule as a ready row's
// Print (reconcileRow) over the whole batch — what has a label is printed,
// the rest the ERP stops waiting for.
export const recoveredRelease = (
  snapshot: BatchSnapshot,
): { bought: string[]; failedIds: string[] } => {
  const { bought, failedIds } = reconcileRow(
    {
      batch: snapshot.batch,
      bought: [],
      failedIds: (snapshot.items ?? []).map((item) => item.karrio_shipment_id),
      notAttempted: [],
    },
    snapshot,
  );
  return { bought, failedIds };
};

// What the empty-selection entry finds among the batches pre-staged
// earlier: rows waiting to be printed (Open — nothing else is), and finished
// batches that did not print a label they hold (their Print again). Queued
// and Printing are on their way and need nobody.
export const prestagedEarlier = (
  batches: BatchSnapshot[],
): { waiting: number; unprinted: number } => ({
  waiting: batches.filter((snapshot) => snapshot.status === "Open").length,
  unprinted: batches.filter((snapshot) => recoveredFailure(snapshot) !== null)
    .length,
});

// A batch found again after a reload has no rows on this list: the ERP names
// its shipments, not their parcels, so each counts as one label.
export const recoveredTargets = (snapshot: BatchSnapshot): ShipmentSummary[] =>
  (snapshot.items ?? []).map((item) => ({
    id: item.karrio_shipment_id,
    orderLabel: item.karrio_shipment_id,
    method: "",
    own: false,
    units: 1,
    labels: 1,
  }));

// A batch found again that finished without printing everything it holds:
// Print again (the ERP's retry) over the labels that did not come out.
// Nothing for a batch that is open, on its way, printed or unknown.
export function recoveredFailure(snapshot: BatchSnapshot): PrintFailure | null {
  if (!["Failed", "Partially Printed"].includes(snapshot.status)) return null;
  const unconfirmed = (snapshot.items ?? [])
    .filter((item) => item.label_attached && item.state !== "Printed")
    .map((item) => item.karrio_shipment_id);
  return printFailure(recoveredTargets(snapshot), [], unconfirmed, snapshot.batch);
}

// When the ERP's safety net prints these batches by itself: the earliest of
// their auto_release_at, or null when the ERP has not said.
export const autoReleaseAt = (
  batches: string[],
  snapshots: BatchSnapshots,
): string | null =>
  batches
    .map((batch) => snapshots[batch]?.auto_release_at)
    .filter((at): at is string => Boolean(at))
    .sort((a, b) => clockValue(a) - clockValue(b))[0] ?? null;

// Frappe writes "2026-11-26 16:05:00"; not every browser parses the space.
const parseTime = (iso: string): Date => new Date(iso.replace(" ", "T"));
const clockValue = (iso: string): number => parseTime(iso).getTime();

// "16:05". A time without an offset is the ERP's own local time — the
// warehouse clock — and reads as such in the browser.
export function clockTime(
  iso: string | null | undefined,
  timeZone?: string,
): string | null {
  if (!iso) return null;
  const time = parseTime(iso);
  if (Number.isNaN(time.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(time);
}

// When the ERP's safety net prints a held batch by itself, as the operator
// reads it: "at 16:05" — or "any moment now" once that time has passed,
// never a time in the past. Null when the ERP has not said.
export function autoPrintWhen(
  iso: string | null | undefined,
  now: number,
  timeZone?: string,
): string | null {
  const time = clockTime(iso, timeZone);
  if (!iso || !time) return null;
  return clockValue(iso) <= now ? "any moment now" : `at ${time}`;
}
