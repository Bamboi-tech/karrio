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
import { toast } from "@karrio/ui/hooks/use-toast";
import {
  CheckCircle2,
  Layers,
  Loader2,
  Printer,
  RotateCcw,
  Square,
  XCircle,
} from "lucide-react";

// The Pick & Print popup: the whole warehouse run happens in here.
//
// Buying is grouped the way boxes are packed, because that is what puts the
// right label on the right box (the grouping rules live in ./picklist, which
// is pure and unit-tested):
//
// - Single-SKU orders whose every unit is its own parcel are interchangeable
//   within their SKU: pick the stack, hit Print on that row, and any label of
//   that batch fits any box of that stack.
// - Orders mixing SKUs — and single-SKU orders boxed as ONE parcel for
//   several units (the direct-carrier layout), whose label states that box's
//   contents — are packed one at a time: their own section, one Print per
//   order, so their labels never mingle with a stack.
//
// A row's status is the printer's truth, not the purchase's: it turns green
// only when the ERP has mirrored `printed_at` — which it stamps after
// PrintNode reported every job delivered to the printer host — and red when
// the purchase failed or the printer never confirmed. Grey is "no action
// yet".
//
// With pre-staging on (btn_print_batch + btn_prestage_labels) the header's
// "Pre-stage labels" buys every row up front, one after the other, into
// pre-staged ERP print batches that print nothing yet; each row's Print then
// only releases its batch, and the stack's labels come out in seconds. Rows
// of orders whose address was resolved get their own section, last. The run
// logic (order, Stop, Retry, what a release skips) lives in ./picklist too.
//
// The operator confirms every row (picked + labeled); the closing button
// only unlocks when everything is confirmed.

import {
  autoPrintWhen,
  autoReleaseAt,
  batchesToPoll,
  buildPicklist,
  canPrintAgain,
  freshSnapshot,
  heldCounts,
  interruptedRow,
  isBusy,
  isPollPaused,
  isPurchasing,
  labelCount,
  orderKey,
  picklistRows,
  pollStall,
  prestagedRow,
  prestageOutcome,
  prestageQueue,
  printFailure,
  printVerdict,
  progressLabels,
  queueRows,
  readyIds,
  readyLabels,
  readyRows,
  reconcileRow,
  recoveredFailure,
  recoveredRelease,
  recoveredTargets,
  releaseFailedIds,
  resumePoll,
  rowPrintOrder,
  stackKey,
  unqueueRows,
  BatchSnapshot,
  BuyOptions,
  BuyPhase,
  BuyResult,
  MixedOrder,
  Picklist,
  PicklistRow,
  PicklistShipmentLike,
  PollStall,
  PrestagedRow,
  PRESTAGE_POLL_MS,
  PRINT_STATUS_TIMEOUT_MS,
  PrintConfirmation,
  PrintFailure,
  PurchaseProgress,
  RecoveredPreload,
  RowState,
  ShipmentSummary,
  SkuGroup,
} from "./picklist";

export {
  buildPicklist,
  type BuyOptions,
  type BuyPhase,
  type BuyResult,
  type MixedOrder,
  type Picklist,
  type PicklistShipmentLike,
  type PrintConfirmation,
  type RecoveredPreload,
  type SkuGroup,
};

// A Retry before Print buys outside a run, so it has a stop flag of its own;
// leaving the page raises it like the run's.
type StopFlag = { stopped: boolean };

const recoveredKey = (batch: string) => `batch:${batch}`;

export function PicklistDialog({
  open,
  onOpenChange,
  shipments,
  onBuyShipments,
  onAwaitPrinted,
  onRetryPrintBatch,
  onConfirmAll,
  onOpenLabels,
  prestage = false,
  onReleasePrintBatch,
  onPrintBatchStatus,
  recoveredPreload = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shipments: PicklistShipmentLike[];
  // Buys (pick + purchase, sequentially) the given shipments. Provided by
  // the page, which owns the mutation hooks and the toasts.
  onBuyShipments: (ids: string[], options?: BuyOptions) => Promise<BuyResult>;
  // Polls the bought shipments until the ERP mirrors printed_at (stamped
  // after PrintNode reported the jobs delivered to the printer host) or
  // gives up — the green/red verdict. onProgress gets every id confirmed so
  // far; signal stops the poll. batched: the labels come out as one merged
  // ERP job, so the first confirmation lands only once the whole job printed.
  // alsoIds: released as failed, watched but never waited for (see
  // awaitPrintConfirmation) — only a pre-staged row's Print passes them.
  onAwaitPrinted: (
    ids: string[],
    onProgress?: (printed: string[]) => void,
    signal?: AbortSignal,
    batched?: boolean,
    alsoIds?: string[],
  ) => Promise<PrintConfirmation>;
  // Print again: asks the ERP to re-send a print batch's merged job. Rejects
  // with an Error carrying the ERP's own sentence (nothing to retry, the
  // previous job is still alive), which the row shows as is.
  onRetryPrintBatch?: (batch: string) => Promise<void>;
  // Fired once when the operator confirms the whole run (every row ticked).
  // The page uses it to record the own-delivery picks.
  onConfirmAll?: (ownIds: string[]) => void;
  // PDF fallback over everything bought so far — for the day the printer or
  // PrintNode is down. Absent until something was bought.
  onOpenLabels?: (() => void) | null;
  // Pre-staging ("Labels klaarzetten"): both ERP flags are on. Without it —
  // or without the two callbacks below — the popup is exactly the one-click
  // Print popup it always was.
  prestage?: boolean;
  // A ready row's Print: release its pre-staged batch. Resolves true once the
  // ERP took the release, false when it did not (the page said why, and the
  // row stays ready). fallback: what to tell the operator about the ERP's
  // own safety net in that case.
  onReleasePrintBatch?: (
    batch: string,
    failedIds: string[],
    fallback: string,
  ) => Promise<boolean>;
  // The ERP's print_batch_status: named batches, or null for the recent
  // pre-staged ones (how the popup finds them again after a reload).
  onPrintBatchStatus?: (
    batches: string[] | null,
  ) => Promise<{ batches: BatchSnapshot[] }>;
  // That recent list, when the page already asked for it to decide whether
  // to open the popup at all: used as is instead of asking again.
  recoveredPreload?: RecoveredPreload | null;
}) {
  const prestageOn = Boolean(prestage && onReleasePrintBatch && onPrintBatchStatus);
  const picklist = React.useMemo(
    () => buildPicklist(shipments, { separateResolved: prestageOn }),
    [shipments, prestageOn],
  );
  const displayRows = React.useMemo(() => picklistRows(picklist), [picklist]);
  const [ticked, setTicked] = React.useState<string[]>([]);
  const [rows, setRows] = React.useState<Record<string, RowState>>({});
  // A pre-stage run in progress, and whether Stop was pressed on it. The
  // ref is what the page's purchase loop asks between two purchases.
  const [running, setRunning] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const stopRef = React.useRef(false);
  const [runNote, setRunNote] = React.useState<string | null>(null);
  // Each pre-staged row's last progress report: names its batch even when
  // its purchase run breaks off (interruptedRow).
  const progressRef = React.useRef<Record<string, PurchaseProgress>>({});
  // The ERP's last word per batch, the batches whose last poll failed, and
  // the pre-staged batches found when the popup opened (null: not asked).
  const [snapshots, setSnapshots] = React.useState<Record<string, BatchSnapshot>>({});
  const snapshotsRef = React.useRef(snapshots);
  snapshotsRef.current = snapshots;
  // Polls without news per batch: a batch quiet for two minutes is paused
  // until the operator acts on its row (see POLL_STALL_TICKS).
  const [stall, setStall] = React.useState<PollStall>({});
  const resume = (batch: string) => setStall((current) => resumePoll(current, batch));
  const [statusUnknown, setStatusUnknown] = React.useState<string[]>([]);
  // The stop flags of Retries in flight (see StopFlag).
  const retryStops = React.useRef(new Set<StopFlag>());
  const [recovered, setRecovered] = React.useState<string[] | null>(null);
  const [recoveredError, setRecoveredError] = React.useState(false);
  const [closeIntent, setCloseIntent] = React.useState<
    "close" | "confirm-all" | null
  >(null);
  // Two different locks. Purchases are strictly sequential (Monta's
  // verification window, the ERP's row locks), so ONE row buying blocks
  // every other Print — and so does one recording its picks, the first half
  // of the same run, and a pre-stage run as a whole. Waiting for the printer
  // is not a purchase: while row A polls for its confirmation, row B may
  // start buying — the picker packs the next stack while the first one
  // prints. A pre-staged (ready) row is neither: its Print only releases.
  const purchasing = isPurchasing(rows, running);
  const busy = isBusy(rows, running);
  // Leaving the page mid-wait unmounts the popup: stop its printer polls.
  // Made in the effect, not at render — StrictMode's mount → unmount → mount
  // would otherwise hand every later poll an already aborted signal.
  const abortRef = React.useRef<AbortController | null>(null);
  // Leaving mid-run stops the run too, and any Retry: no row may be bought
  // into a held batch nobody is looking at (the purchase in flight still
  // finishes).
  React.useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    const stops = retryStops.current;
    return () => {
      controller.abort();
      stopRef.current = true;
      stops.forEach((flag) => {
        flag.stopped = true;
      });
    };
  }, []);

  // A fresh run is a fresh sheet: confirmations are about THIS run's boxes,
  // never yesterday's.
  React.useEffect(() => {
    if (open) {
      setTicked([]);
      setRows({});
      setSnapshots({});
      setStall({});
      setStatusUnknown([]);
      setRunNote(null);
      setCloseIntent(null);
      progressRef.current = {};
    }
  }, [open, shipments]);

  // The callbacks come from the page's render; the effects below keep
  // running across renders and read the latest one through this ref.
  const statusRef = React.useRef(onPrintBatchStatus);
  statusRef.current = onPrintBatchStatus;
  const preloadRef = React.useRef(recoveredPreload);
  preloadRef.current = recoveredPreload;

  // Rows pre-staged before a reload (or before the popup was last closed):
  // the ERP still holds them, and the popup offers their Print again. A list
  // that could not be loaded says so — it never reads as "nothing there".
  React.useEffect(() => {
    setRecovered(null);
    setRecoveredError(false);
    if (!open || !prestageOn) return;
    let cancelled = false;
    const found = ({ batches }: { batches: BatchSnapshot[] }) => {
      if (cancelled) return;
      setRecovered(batches.map((snapshot) => snapshot.batch));
      setSnapshots((current) => ({
        ...current,
        ...Object.fromEntries(batches.map((snapshot) => [snapshot.batch, snapshot])),
      }));
    };
    const preload = preloadRef.current;
    if (preload) {
      if ("error" in preload) setRecoveredError(true);
      else found(preload);
      return;
    }
    statusRef.current?.(null)
      .then(found)
      .catch(() => {
        if (!cancelled) setRecoveredError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, prestageOn]);

  // One status call for every watched batch, every few seconds, only while
  // labels are still arriving (a row buying, a ready row not complete yet)
  // or an earlier batch is on its way to the printer — and not for a batch
  // that has had nothing new for two minutes (paused until its row is acted
  // on). A failed poll keeps the last known count and says "status
  // unknown"; Print never depends on it.
  const pollKey = prestageOn
    ? batchesToPoll(rows, snapshots, recovered ?? [], stall).join("|")
    : "";
  React.useEffect(() => {
    if (!pollKey) return;
    const names = pollKey.split("|");
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight || !statusRef.current) return;
      inFlight = true;
      const before = snapshotsRef.current;
      try {
        const { batches } = await statusRef.current(names);
        if (cancelled) return;
        // An "Unknown" answer never overwrites what the ERP said before.
        const known = Object.fromEntries(
          batches
            .filter((snapshot) => snapshot.status !== "Unknown")
            .map((snapshot) => [snapshot.batch, snapshot]),
        );
        const knownNames = Object.keys(known);
        setSnapshots((current) => ({ ...current, ...known }));
        setStall((current) =>
          pollStall(current, names, before, { ...before, ...known }),
        );
        setStatusUnknown((current) =>
          Array.from(
            new Set([
              ...current.filter((name) => !names.includes(name)),
              ...names.filter((name) => !knownNames.includes(name)),
            ]),
          ),
        );
      } catch {
        if (!cancelled) {
          setStatusUnknown((current) => Array.from(new Set([...current, ...names])));
          setStall((current) => pollStall(current, names, before, before));
        }
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const timer = setInterval(tick, PRESTAGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollKey]);

  const rowKeys = displayRows.map((row) => row.key);
  const rowByKey = new Map(displayRows.map((row) => [row.key, row]));
  const allConfirmed =
    rowKeys.length > 0 && rowKeys.every((key) => ticked.includes(key));
  const totalLabels = labelCount(displayRows.flatMap((row) => row.targets));
  const queue = prestageOn ? prestageQueue(displayRows, rows) : [];

  const setRow = (key: string, state: RowState) =>
    setRows((current) => ({ ...current, [key]: state }));

  const toggle = (key: string, checked: boolean) =>
    setTicked((current) =>
      checked ? [...current, key] : current.filter((k) => k !== key),
    );

  // Nothing of the row got a label: every shipment goes back on the Retry.
  const purchaseFailed = (targets: ShipmentSummary[]): RowState => ({
    phase: "failed",
    reason: "Purchase failed",
    retryIds: targets.map((t) => t.id),
    retryLabels: labelCount(targets),
    printBatch: null,
    unconfirmedIds: [],
  });

  // From a finished purchase to the printer's verdict: wait for the bought
  // labels to be confirmed, then green, or red with what still needs doing.
  // watchFailed (a released pre-staged row): the purchases released as
  // failed are watched too — one whose label prints after all is no
  // failure, and gets no Retry (printVerdict) — without ever holding the
  // row up past a short grace.
  const settle = async (
    key: string,
    targets: ShipmentSummary[],
    result: BuyResult,
    watchFailed = false,
  ) => {
    const failedIds = releaseFailedIds({
      failedIds: result.failedIds,
      notAttempted: result.notAttempted ?? [],
    });
    if (result.purchased.length === 0 && !(watchFailed && failedIds.length > 0)) {
      setRow(key, purchaseFailed(targets));
      return;
    }

    const progress = (printed: string[]) =>
      setRow(key, {
        phase: "confirming",
        ...progressLabels(targets, result.purchased, printed),
      });
    progress([]);
    const confirmation = await onAwaitPrinted(
      result.purchased,
      progress,
      abortRef.current?.signal,
      Boolean(result.printBatch),
      watchFailed ? failedIds : undefined,
    );
    const failure = printVerdict(
      targets,
      failedIds,
      confirmation,
      result.printBatch,
    );
    if (failure) {
      setRow(key, { phase: "failed", ...failure });
      return;
    }
    setRow(key, { phase: "printed", labels: labelCount(targets) });
  };

  const buy = async (key: string, targets: ShipmentSummary[]) => {
    setRow(key, { phase: "buying" });
    try {
      const result = await onBuyShipments(
        targets.map((t) => t.id),
        {
          printOrder: rowPrintOrder(targets).map((t) => t.id),
          onPhase: (phase) => setRow(key, { phase }),
        },
      );
      await settle(key, targets, result);
    } catch {
      // The page already toasts the failure; the row goes back to printable.
      setRow(key, purchaseFailed(targets));
    }
  };

  // Buys one row into a pre-staged batch: picks, open, purchases — and no
  // release. `previous` is the ready row a Retry buys the missing labels
  // into (same batch, no new picks). Whatever happens, a batch the ERP
  // opened pre-staged ends up on a ready row, never forgotten — or, when a
  // Stop left it without a single label, released at once (abandoned). If
  // the ERP did not pre-stage, the page released the batch itself and the
  // row prints the normal way (degraded); if it held none of the row's
  // shipments, they printed on their purchase (unheld) and the run goes on.
  // "failed": the purchase run broke off with an error.
  const prestageRow = async (
    row: PicklistRow,
    targets: ShipmentSummary[],
    previous: PrestagedRow | undefined,
    shouldStop: () => boolean,
  ): Promise<"ready" | "unheld" | "stopped" | "degraded" | "failed"> => {
    const { key } = row;
    const ids = targets.map((t) => t.id);
    progressRef.current[key] = {
      batch: previous?.batch ?? null,
      bought: [],
      failedIds: [],
    };
    setRow(key, { phase: previous ? "buying" : "picking" });
    try {
      const result = await onBuyShipments(ids, {
        printOrder: rowPrintOrder(targets).map((t) => t.id),
        onPhase: (phase) => setRow(key, { phase }),
        prestage: {
          rowLabel: row.label,
          batch: previous?.batch ?? null,
          shouldStop,
          onProgress: (progress) => {
            progressRef.current[key] = progress;
            setRow(key, {
              phase: "buying",
              progress: { ...progress, total: ids.length },
            });
          },
        },
      });
      const outcome = prestageOutcome(result, previous);
      if (outcome.kind === "ready") {
        // New labels in the batch: whatever paused its poll is over.
        resume(outcome.row.batch);
        setRow(key, { phase: "ready", ...outcome.row });
        return "ready";
      }
      if (outcome.kind === "abandoned") {
        // Not one label in it: the ERP must not hold an empty batch for two
        // hours. A release it does not take changes nothing on paper — the
        // row is back to grey either way.
        await onReleasePrintBatch?.(
          outcome.batch,
          outcome.failedIds,
          "It holds no labels; the ERP closes it by itself later.",
        ).catch(() => false);
        setRow(key, { phase: "idle" });
        if (outcome.uncertain.length > 0) {
          toast({
            title: `Stopped — ${row.label}: a purchase may still have gone through`,
            description:
              "It failed here, but it may have reached the carrier. If so, its label prints by itself.",
          });
        }
        return "stopped";
      }
      if (outcome.kind === "stopped") {
        setRow(key, { phase: "idle" });
        return "stopped";
      }
      // Not held: released already (degraded) or never batched (unheld), so
      // it prints like a plain Print. Not awaited — the printer wait is no
      // purchase and must not hold the run's lock.
      void settle(key, targets, result).catch(() =>
        setRow(key, purchaseFailed(targets)),
      );
      return outcome.kind;
    } catch {
      const interrupted = interruptedRow(progressRef.current[key], targets);
      if (interrupted) {
        // Never forgotten: the row is ready over its batch. The run stops
        // all the same — something is wrong.
        setRow(key, {
          phase: "ready",
          ...prestagedRow(
            interrupted.batch,
            {
              purchased: interrupted.bought,
              failedIds: interrupted.failedIds,
              notAttempted: interrupted.notAttempted,
            },
            previous,
          ),
        });
        return "failed";
      }
      setRow(key, previous ? { phase: "ready", ...previous } : purchaseFailed(targets));
      return "failed";
    }
  };

  // "Pre-stage labels": every untouched row, in display order, one after the
  // other. Starts only from the button, never by itself.
  const startRun = async () => {
    if (purchasing || queue.length === 0) return;
    stopRef.current = false;
    setStopping(false);
    setRunNote(null);
    setRunning(true);
    setRows((current) => queueRows(current, queue.map((row) => row.key)));
    try {
      for (const row of queue) {
        if (stopRef.current) break;
        const outcome = await prestageRow(
          row,
          row.targets,
          undefined,
          () => stopRef.current,
        );
        if (outcome === "degraded") {
          // The ERP does not pre-stage (yet): this row printed the normal
          // way, and the rest of the list must not print in one go.
          setRunNote(
            "Pre-staging is not available — this row printed right away and the run stopped.",
          );
        }
        if (outcome === "failed") {
          setRunNote(
            `The run stopped: buying ${row.label} broke off with an error. Ready rows can still be printed.`,
          );
        }
        // Ready, or nothing to hold (its labels printed on their purchase):
        // on to the next row. Anything else ends the run.
        if (outcome !== "ready" && outcome !== "unheld") break;
      }
    } finally {
      setRows((current) => unqueueRows(current));
      setRunning(false);
      setStopping(false);
    }
  };

  const stopRun = () => {
    stopRef.current = true;
    setStopping(true);
  };

  // One fresh status of a batch, right before Print or Retry decides on it
  // (freshSnapshot): the last poll may be minutes old, or paused. What the
  // ERP said is kept for the row's count; when it fails or is slow, the last
  // known snapshot decides — Print never needs the status API.
  const latestSnapshot = async (batch: string) => {
    const known = snapshotsRef.current[batch];
    if (!statusRef.current) return known;
    const fresh = await freshSnapshot({
      batch,
      known,
      fetchStatus: statusRef.current,
      timeoutMs: PRINT_STATUS_TIMEOUT_MS,
    });
    if (fresh && fresh !== known) {
      setSnapshots((current) => ({ ...current, [batch]: fresh }));
    }
    return fresh;
  };

  // A ready row's Print: release the held batch — telling the ERP which
  // purchases never happened — then wait for the printer as any batch row.
  // What never happened is read against a fresh status of the batch
  // (latestSnapshot, reconcileRow): a purchase that timed out here but whose
  // label the batch holds is printed and waited for, never released as
  // failed. What is released as failed is still watched (settle's
  // watchFailed). A release the ERP did not take leaves the row ready, Print
  // still there.
  const printReady = async (
    key: string,
    targets: ShipmentSummary[],
    state: PrestagedRow,
  ) => {
    if (!onReleasePrintBatch) return;
    resume(state.batch);
    // The spinner at once: the row is taken while its status is read.
    setRow(key, {
      phase: "confirming",
      ...progressLabels(targets, state.bought, []),
    });
    const latest = await latestSnapshot(state.batch);
    const row = reconcileRow(state, latest);
    const failedIds = releaseFailedIds(row);
    const when = autoPrintWhen(latest?.auto_release_at, Date.now());
    setRow(key, {
      phase: "confirming",
      ...progressLabels(targets, row.bought, []),
    });
    const released = await onReleasePrintBatch(
      state.batch,
      failedIds,
      when
        ? `Its labels print automatically ${when}.`
        : "Its labels print automatically once the ERP releases the batch.",
    ).catch(() => false);
    if (!released) {
      setRow(key, { phase: "ready", ...row });
      return;
    }
    await settle(
      key,
      targets,
      {
        purchased: row.bought,
        failures: [],
        failedIds,
        printBatch: state.batch,
      },
      true,
    ).catch(() => setRow(key, purchaseFailed(targets)));
  };

  // Retry before Print: buy what is missing into the same held batch — not
  // what a fresh status shows the batch holds after all (reconcileRow): a
  // second purchase there is a second label. It has a stop flag of its own,
  // raised when the popup goes away.
  const retryReady = async (
    key: string,
    targets: ShipmentSummary[],
    state: PrestagedRow,
  ) => {
    const row = rowByKey.get(key);
    if (!row || purchasing) return;
    const flag: StopFlag = { stopped: false };
    retryStops.current.add(flag);
    resume(state.batch);
    // Takes the purchase lock at once: nothing else buys while it looks.
    setRow(key, { phase: "buying" });
    try {
      const latest = await latestSnapshot(state.batch);
      const current = reconcileRow(state, latest);
      const missing = releaseFailedIds(current);
      if (missing.length === 0 || flag.stopped) {
        setRow(key, { phase: "ready", ...current });
        return;
      }
      await prestageRow(
        row,
        targets.filter((target) => missing.includes(target.id)),
        current,
        () => flag.stopped,
      );
    } catch {
      // Never left holding the purchase lock: back to the row it was.
      setRow(key, { phase: "ready", ...state });
    } finally {
      retryStops.current.delete(flag);
    }
  };

  // Print again: the ERP re-sends the row's merged job, and the row waits for
  // the labels the printer never confirmed — the purchase Retry (retryIds)
  // stays on the row untouched. An ERP refusal keeps the row red with the
  // ERP's own sentence next to it; Open label PDFs remains the way out.
  const printAgain = async (
    key: string,
    targets: ShipmentSummary[],
    failure: PrintFailure,
  ) => {
    const batch = failure.printBatch;
    if (!batch || !onRetryPrintBatch) return;
    const { unconfirmedIds } = failure;
    const progress = (printed: string[]) =>
      setRow(key, {
        phase: "confirming",
        ...progressLabels(targets, unconfirmedIds, printed),
      });
    progress([]);
    try {
      await onRetryPrintBatch(batch);
    } catch (error) {
      setRow(key, {
        phase: "failed",
        ...failure,
        printError:
          error instanceof Error && error.message
            ? error.message
            : "The ERP refused to print this batch again.",
      });
      return;
    }
    // Never leaves the row spinning: the popup stays locked while it does.
    const confirmation = await onAwaitPrinted(
      unconfirmedIds,
      progress,
      abortRef.current?.signal,
      true,
    ).catch(() => ({ printed: [], unconfirmed: unconfirmedIds }));
    const next = printFailure(
      targets,
      failure.retryIds,
      confirmation.unconfirmed,
      batch,
    );
    setRow(
      key,
      next
        ? { phase: "failed", ...next }
        : { phase: "printed", labels: labelCount(targets) },
    );
  };

  const confirmAll = () => {
    onConfirmAll?.(
      [
        ...picklist.groups.flatMap((group) => group.shipments),
        ...picklist.mixed,
        ...picklist.resolved.groups.flatMap((group) => group.shipments),
        ...picklist.resolved.mixed,
      ]
        .filter((shipment) => shipment.own)
        .map((shipment) => shipment.id),
    );
    onOpenChange(false);
  };

  // Closing over pre-staged rows that were not printed asks first: the ERP
  // prints them by itself later, unattended, and the operator should know
  // when.
  const unprinted = prestageOn ? readyRows(rows) : [];
  const finishClose = (intent: "close" | "confirm-all") => {
    setCloseIntent(null);
    if (busy) return;
    if (intent === "confirm-all") confirmAll();
    else onOpenChange(false);
  };
  const requestClose = (intent: "close" | "confirm-all") => {
    if (busy) return;
    if (unprinted.length > 0) {
      setCloseIntent(intent);
      return;
    }
    finishClose(intent);
  };
  const autoPrint = autoPrintWhen(
    autoReleaseAt(
      unprinted.map((row) => row.batch),
      snapshots,
    ),
    Date.now(),
  );

  // A batch whose poll is paused says so, with the way to look again.
  const pausedNote = (batch: string) =>
    isPollPaused(stall, batch) && (
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0 text-xs text-muted-foreground"
        title="Nothing changed in the ERP for two minutes, so the popup stopped asking. Print works regardless."
        onClick={() => resume(batch)}
      >
        check again
      </Button>
    );

  // One cell tells the row's whole story: grey button (nothing happened),
  // spinner (picking / buying / waiting for the printer, with its count so
  // far), blue (pre-staged: held in the ERP, Print releases it), green
  // (printer confirmed), red (failed, with a retry over what is still
  // unlabeled and, for a print batch, a Print again). allowRetry is off for
  // batches found again after a reload: their shipments are not on this
  // list, so there is nothing here to buy them with.
  const statusCell = (
    key: string,
    targets: ShipmentSummary[],
    allowRetry = true,
  ) => {
    const state = rows[key] || { phase: "idle" };
    const labels = labelCount(targets);

    if (targets.length === 0) {
      return <span className="text-xs text-muted-foreground">pick only</span>;
    }
    switch (state.phase) {
      case "queued":
        return (
          <span className="text-xs text-muted-foreground">Queued</span>
        );
      case "picking":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Picking…
          </span>
        );
      case "buying":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Buying…
            {state.progress &&
              ` ${state.progress.bought.length + state.progress.failedIds.length}/${state.progress.total}`}
            {state.progress && state.progress.failedIds.length > 0 && (
              <span className="text-red-700">
                · {state.progress.failedIds.length} failed
              </span>
            )}
          </span>
        );
      case "ready": {
        const latest = snapshots[state.batch];
        const current = reconcileRow(state, latest);
        const count = readyLabels(
          targets,
          current.bought,
          readyIds(latest, current.bought),
        );
        const missing = releaseFailedIds(current);
        const missingLabels = labelCount(
          targets.filter((target) => missing.includes(target.id)),
        );
        const unknown = statusUnknown.includes(state.batch);
        return (
          <span className="inline-flex items-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700"
              title="Bought and held in the ERP — nothing printed yet"
            >
              <Layers className="h-3.5 w-3.5" /> Ready
            </span>
            {allowRetry && missing.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={purchasing}
                title="Buy the missing labels into the same held batch"
                onClick={() => retryReady(key, targets, state)}
              >
                <RotateCcw className="h-3 w-3 mr-1" /> Retry {missingLabels}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs tabular-nums"
              title={`${count.attachedLabels ?? "?"} of ${count.labels} label(s) attached in the ERP — Print sends the stack to the printer`}
              onClick={() => printReady(key, targets, state)}
            >
              <Printer className="h-3.5 w-3.5 mr-1.5" />
              Print {count.attachedLabels ?? "?"}/{count.labels}
            </Button>
            {unknown && (
              <span className="text-xs text-muted-foreground">
                status unknown
              </span>
            )}
            {pausedNote(state.batch)}
          </span>
        );
      }
      case "confirming":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for
            printer… {state.confirmedLabels}/{state.labels}
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
            {state.printError && (
              <span className="max-w-[16rem] whitespace-normal text-left text-xs text-red-700">
                {state.printError}
              </span>
            )}
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700"
              title={state.reason}
            >
              <XCircle className="h-3.5 w-3.5" /> Failed
            </span>
            {onRetryPrintBatch && canPrintAgain(state) && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                title="Send this row's labels to the printer again"
                onClick={() => printAgain(key, targets, state)}
              >
                <Printer className="h-3 w-3 mr-1" /> Print again
              </Button>
            )}
            {allowRetry && state.retryIds.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={purchasing}
                onClick={() =>
                  buy(
                    key,
                    targets.filter((t) => state.retryIds.includes(t.id)),
                  )
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
            disabled={purchasing}
            onClick={() => buy(key, targets)}
          >
            <Printer className="h-3.5 w-3.5 mr-1.5" />
            Print {labels} label{labels === 1 ? "" : "s"}
          </Button>
        );
    }
  };

  // A batch pre-staged earlier: Print while the ERP still holds it, its
  // progress once printing from here, or where the ERP says it is.
  const recoveredCell = (snapshot: BatchSnapshot) => {
    const key = recoveredKey(snapshot.batch);
    const targets = recoveredTargets(snapshot);
    if (rows[key]) return statusCell(key, targets, false);
    if (snapshot.status === "Open") {
      const { bought, failedIds } = recoveredRelease(snapshot);
      const counts = heldCounts(snapshot);
      const when = autoPrintWhen(snapshot.auto_release_at, Date.now());
      return (
        <span className="inline-flex items-center gap-2">
          {pausedNote(snapshot.batch)}
          {when && (
            <span className="text-xs text-muted-foreground">
              prints automatically {when}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs tabular-nums"
            title="Send this row's held labels to the printer"
            onClick={() =>
              printReady(key, targets, {
                batch: snapshot.batch,
                bought,
                failedIds,
                notAttempted: [],
              })
            }
          >
            <Printer className="h-3.5 w-3.5 mr-1.5" />
            Print {counts.attached}/{counts.total}
          </Button>
        </span>
      );
    }
    const failure = recoveredFailure(snapshot);
    if (failure) {
      return (
        <span className="inline-flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700"
            title={failure.reason}
          >
            <XCircle className="h-3.5 w-3.5" /> {snapshot.status}
          </span>
          {onRetryPrintBatch && canPrintAgain(failure) && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              title="Send this row's labels to the printer again"
              onClick={() => printAgain(key, targets, failure)}
            >
              <Printer className="h-3 w-3 mr-1" /> Print again
            </Button>
          )}
        </span>
      );
    }
    if (snapshot.status === "Printed") {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" /> Printed
        </span>
      );
    }
    // Queued or Printing: on its way, followed until it is done.
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        {["Queued", "Printing"].includes(snapshot.status) && (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        )}
        {snapshot.status}
        {pausedNote(snapshot.batch)}
      </span>
    );
  };

  const rowTone = (key: string, isTicked: boolean) => {
    const phase = (rows[key] || { phase: "idle" }).phase;
    if (phase === "printed") return "bg-emerald-50/50";
    if (phase === "failed") return "bg-red-50/50";
    if (phase === "ready") return "bg-sky-50/40";
    return isTicked ? "bg-muted/40" : "";
  };

  const headerCell =
    "py-2 px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground";
  const numberCell = "py-2.5 px-3 text-right tabular-nums";
  const boxesNote = (boxes: number) =>
    prestageOn && (
      <span className="block text-xs text-muted-foreground tabular-nums">
        {boxes} box{boxes === 1 ? "" : "es"}
      </span>
    );

  const stackTable = (groups: SkuGroup[], resolved: boolean) => (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-background shadow-[0_1px_0_0_hsl(var(--border))]">
        <tr className="text-left">
          <th className={`${headerCell} w-10`}></th>
          <th className={headerCell}>SKU</th>
          {picklist.methods.map((method) => (
            <th
              key={method}
              className={`${headerCell} text-right whitespace-nowrap`}
            >
              {method}
            </th>
          ))}
          <th className={`${headerCell} text-right`}>Total</th>
          <th className={`${headerCell} text-right pr-3`}>Labels</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => {
          const row = rowByKey.get(stackKey(group.sku, resolved));
          if (!row) return null;
          const isTicked = ticked.includes(row.key);
          return (
            <tr key={row.key} className={`border-t ${rowTone(row.key, isTicked)}`}>
              <td className="py-2.5 px-3">
                <Checkbox
                  checked={isTicked}
                  onCheckedChange={(checked) => toggle(row.key, checked === true)}
                />
              </td>
              <td
                className={`py-2.5 px-3 ${isTicked ? "text-muted-foreground line-through" : ""}`}
              >
                <span className="font-medium">{group.sku}</span>
                {group.title && (
                  <span className="block text-xs text-muted-foreground">
                    {group.title}
                  </span>
                )}
                {boxesNote(row.boxes)}
              </td>
              {picklist.methods.map((method) => (
                <td key={method} className={numberCell}>
                  {group.perMethod[method] || ""}
                </td>
              ))}
              <td className={`${numberCell} font-semibold`}>{group.total}</td>
              <td className="py-2.5 px-3 text-right whitespace-nowrap">
                {statusCell(row.key, row.targets)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const mixedTable = (orders: MixedOrder[], resolved: boolean) => (
    <table className="w-full text-sm">
      <tbody>
        {orders.map((order) => {
          const row = rowByKey.get(orderKey(order.id, resolved));
          if (!row) return null;
          const isTicked = ticked.includes(row.key);
          return (
            <tr key={row.key} className={`border-t ${rowTone(row.key, isTicked)}`}>
              <td className="py-2.5 px-3 w-10">
                <Checkbox
                  checked={isTicked}
                  onCheckedChange={(checked) => toggle(row.key, checked === true)}
                />
              </td>
              <td
                className={`py-2.5 px-3 ${isTicked ? "text-muted-foreground line-through" : ""}`}
              >
                <span className="font-medium">{order.orderLabel}</span>
                <span className="block text-xs text-muted-foreground">
                  {order.lines.map((line) => `${line.qty}× ${line.sku}`).join(" · ")}
                </span>
                {boxesNote(row.boxes)}
              </td>
              <td className="py-2.5 px-3 text-right text-xs text-muted-foreground whitespace-nowrap">
                {order.method}
              </td>
              <td className="py-2.5 px-3 text-right whitespace-nowrap">
                {statusCell(row.key, row.targets)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const sectionTitle = (text: string) => (
    <p className="px-3 pt-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {text}
    </p>
  );

  const hasResolved =
    picklist.resolved.groups.length + picklist.resolved.mixed.length > 0;
  const recoveredSnapshots = (recovered ?? []).flatMap((name) =>
    snapshots[name] ? [snapshots[name]] : [],
  );
  const queueLabels = labelCount(queue.flatMap((row) => row.targets));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : requestClose("close"))}
    >
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between pr-6">
            <span>Pick &amp; Print</span>
            <span className="text-sm font-normal text-muted-foreground">
              {shipments.length} order{shipments.length === 1 ? "" : "s"} ·{" "}
              {totalLabels} label{totalLabels === 1 ? "" : "s"} ·{" "}
              {ticked.length}/{rowKeys.length} confirmed
            </span>
          </DialogTitle>
          <DialogDescription>
            Pick per row, hit Print once the stack of boxes is packed — any
            label from that batch fits any box in the row. Stick the labels,
            tick the row. Mixed orders are packed one at a time.
          </DialogDescription>
        </DialogHeader>

        {prestageOn && rowKeys.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-sky-200 bg-sky-50/60 px-3 py-2">
            {running ? (
              <Button
                variant="outline"
                size="sm"
                disabled={stopping}
                title="Stops after the label being bought now. Labels already bought stay bought — print each ready row with its own Print."
                onClick={stopRun}
              >
                <Square className="h-3.5 w-3.5 mr-1.5" />
                {stopping ? "Stopping…" : "Stop"}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={purchasing || queue.length === 0}
                title="Buys the labels of every row now, one row after the other, and holds them in the ERP. Nothing prints until you press a row's Print."
                onClick={startRun}
              >
                <Layers className="h-3.5 w-3.5 mr-1.5" />
                Pre-stage labels
                {queue.length > 0 && ` (${queueLabels})`}
              </Button>
            )}
            <span className="text-xs text-sky-900">
              {running
                ? "Buying row after row — Print any ready row meanwhile."
                : "Buys every row now; each row prints when you press its Print."}
            </span>
            {runNote && (
              <span className="basis-full text-xs text-amber-800">{runNote}</span>
            )}
          </div>
        )}

        {picklist.shipmentsWithoutItems > 0 && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {picklist.shipmentsWithoutItems} shipment(s) carry no order lines —
            they are not on this list and need handling from the order itself.
          </p>
        )}

        {rowKeys.length === 0 ? (
          prestageOn && recovered === null && !recoveredError ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Loading rows pre-staged earlier…
            </p>
          ) : (
            recoveredSnapshots.length === 0 &&
            !recoveredError && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing to pick in this selection.
              </p>
            )
          )
        ) : (
          <div className="max-h-[60vh] overflow-y-auto rounded-md border">
            {picklist.groups.length > 0 && stackTable(picklist.groups, false)}

            {picklist.mixed.length > 0 && (
              <div className={picklist.groups.length > 0 ? "border-t" : ""}>
                {sectionTitle("Mixed orders — pack one at a time")}
                {mixedTable(picklist.mixed, false)}
              </div>
            )}

            {hasResolved && (
              <div
                className={
                  picklist.groups.length + picklist.mixed.length > 0
                    ? "border-t-2"
                    : ""
                }
              >
                {sectionTitle("Resolved addresses — pack last")}
                {picklist.resolved.groups.length > 0 &&
                  stackTable(picklist.resolved.groups, true)}
                {picklist.resolved.mixed.length > 0 &&
                  mixedTable(picklist.resolved.mixed, true)}
              </div>
            )}
          </div>
        )}

        {prestageOn && (recoveredSnapshots.length > 0 || recoveredError) && (
          <div className="rounded-md border">
            {sectionTitle("Pre-staged earlier")}
            {recoveredError ? (
              <p className="px-3 pb-3 text-xs text-muted-foreground">
                Rows pre-staged earlier could not be loaded — the ERP still
                prints them by itself.
              </p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {recoveredSnapshots.map((snapshot) => (
                    <tr
                      key={snapshot.batch}
                      className={`border-t ${rowTone(recoveredKey(snapshot.batch), false)}`}
                    >
                      <td className="py-2.5 px-3">
                        <span className="font-medium">
                          {snapshot.row_label || snapshot.batch}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {snapshot.batch}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right whitespace-nowrap">
                        {recoveredCell(snapshot)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {closeIntent && !busy && unprinted.length > 0 && (
          <div
            role="alertdialog"
            className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
          >
            <span className="flex-1">
              {unprinted.length} row{unprinted.length === 1 ? "" : "s"}{" "}
              pre-staged, not printed — they print automatically{" "}
              {autoPrint ?? "later"}.
            </span>
            <Button variant="outline" size="sm" onClick={() => setCloseIntent(null)}>
              Keep open
            </Button>
            <Button size="sm" onClick={() => finishClose(closeIntent)}>
              Close anyway
            </Button>
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
            onClick={() => requestClose("confirm-all")}
          >
            All picked &amp; labeled
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
