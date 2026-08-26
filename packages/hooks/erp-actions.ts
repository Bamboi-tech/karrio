import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ManualShipmentStatusEnum } from "@karrio/types";
import { handleFailure } from "@karrio/lib";
import { useKarrio } from "./karrio";

// Bamboi fork: warehouse actions relayed to the ERP so the dashboard is a
// full workstation (Ship Today phase 2). The Karrio server forwards these to
// the ERP's Karrio Shipment document methods with server-held credentials;
// the ERP enforces its own gates (hold/refund/status/mode) and mirrors the
// resulting erp_status back onto the shipment metadata, so the pipeline
// cards follow after a refetch.

// Written into the shipment metadata by the ERP sync. Presence of either key
// means the shipment is ERP-managed; erp_status carries the ERP lifecycle
// (Synced / Picked / Out for Delivery / ...).
export const ERP_LINK_KEYS = ["karrio_shipment", "sales_order"] as const;

export type ERPShipmentAction =
  | "mark-picked"
  | "unmark-picked"
  | "mark-out-for-delivery"
  | "mark-shipped"
  | "mark-delivered"
  | "cancel-shipment"
  | "record-delivery-outcome"
  | "confirm-address"
  | "unmark-shipped"
  | "unmark-out-for-delivery"
  | "unmark-delivered"
  | "undo-delivery-outcome";

// How a post-purchase shipment actually ended. Karrio has no "returned"
// status, so the precise truth lives in the ERP and Karrio only carries the
// status that moves the row to the right card.
export type DeliveryOutcome =
  | "exception"
  | "failed"
  | "delivered"
  | "returned";

// How a post-purchase row can end, offered from Label Created onward.
// Every option writes TWICE: the ERP records the outcome WITH its reason
// (the truth the office reads back), and Karrio's own status is flipped so
// the row actually moves card. Karrio has no "returned" status, so a return
// lands on delivery_failed here and stays a return only in the ERP.
// Shared by the bulk toolbar (core Shipments module) and the per-row menu.
export type DeliveryOutcomeOption = {
  outcome: DeliveryOutcome;
  label: string;
  status: ManualShipmentStatusEnum;
  requiresReason: boolean;
};

export const DELIVERY_OUTCOME_OPTIONS: DeliveryOutcomeOption[] = [
  {
    outcome: "exception",
    label: "Exception",
    status: ManualShipmentStatusEnum.needs_attention,
    requiresReason: true,
  },
  {
    outcome: "failed",
    label: "Failed",
    status: ManualShipmentStatusEnum.delivery_failed,
    requiresReason: true,
  },
  {
    // Delivered would speak for itself, but overriding a TRACKED shipment's
    // status requires a reason (the carrier owns that status; the override
    // is audited on metadata.status_override) — so it prompts like the rest.
    outcome: "delivered",
    label: "Delivered",
    status: ManualShipmentStatusEnum.delivered,
    requiresReason: true,
  },
  {
    outcome: "returned",
    label: "Returned",
    status: ManualShipmentStatusEnum.delivery_failed,
    requiresReason: true,
  },
];

export function isERPLinked(metadata: unknown): boolean {
  const values = (metadata || {}) as Record<string, unknown>;
  return ERP_LINK_KEYS.some((key) => key in values);
}

export function getERPStatus(metadata: unknown): string | null {
  const values = (metadata || {}) as Record<string, unknown>;
  const status = values["erp_status"];
  return typeof status === "string" && status.length > 0 ? status : null;
}

// The only ERP status Mark Picked is defined to act from (the ERP's own
// _assert_status on mark_picked). Everything past it — Picked, Label Created,
// In Transit — is a shipment that has already been picked or has moved beyond
// picking, and asking again can only be refused.
export const ERP_PICKABLE_STATUS = "Synced";

// Would a Mark Picked on this row stand a chance? Only a mirrored status that
// positively says the row already moved on answers no; an unmirrored shipment
// still gets the call, because "we do not know" is not "we know it is too
// late" and the ERP is the one allowed to decide.
export function canMarkPicked(metadata: unknown): boolean {
  const status = getERPStatus(metadata);
  return status === null || status === ERP_PICKABLE_STATUS;
}

// Buy & print's first step, made survivable.
//
// Picking is bookkeeping: it moves an ERP status and writes a comment, and
// tells nobody anything. Buying the label is the act with consequences, and
// it carries the real gate — the ERP re-runs the whole composite label gate
// (hold / refund / address / mode) on every purchase and fails closed. So a
// pick that cannot be recorded must never cost the operator the label.
//
// It used to. mark-picked ran first and a refusal aborted the row, which made
// buy & print un-repeatable: the second press on a row whose pick had already
// landed (a print that jammed, a stale mirrored erp_status, a batch re-run)
// was refused with "Mark Picked needs a shipment that is Synced (is: Picked /
// Label Created)" and the label was never re-opened — 20 such refusals in
// four days, all of them from this button.
//
// Now the call is skipped when the mirrored status already says it is moot,
// and a refusal is handed back instead of thrown so the caller can buy the
// label anyway and mention what did not get recorded.
export async function pickForPurchase(
  markPicked: {
    mutateAsync: (variables: { id: string }) => Promise<{ message: string }>;
  },
  shipment: { id: string; metadata?: unknown },
): Promise<{ picked: boolean; error: unknown }> {
  if (!isERPLinked(shipment.metadata) || !canMarkPicked(shipment.metadata)) {
    return { picked: false, error: null };
  }
  try {
    await markPicked.mutateAsync({ id: shipment.id });
    return { picked: true, error: null };
  } catch (error) {
    return { picked: false, error };
  }
}

// Mark shipped used to be ERP bookkeeping only, and the UX said otherwise:
// the success toast spoke of In Transit while the row stayed on the Picked
// card, because the cards follow Karrio's OWN status and nothing in the flow
// changed it — only the carrier's first scan did, hours later. So the action
// now moves both, in the same order recordDeliveryOutcome settled on: ERP
// first (that write carries the gate and the truth), then Karrio's status so
// the row is on the Shipped card before the operator looks up.
//
// The status flip is guarded twice:
// - only from a pre-transit status — a row the tracker already advanced (or
//   finished: Delivered) must never be dragged back to In Transit by a late
//   click, which the ERP tolerates as a no-op ("already in transit");
// - tracked shipments require a reason for a manual override, so the click
//   supplies one; the server stamps who/when onto metadata.status_override.
export const MARK_SHIPPED_STATUS_REASON =
  "Mark shipped: handed to the carrier before the first tracker scan";

// "created" is what the REST list returns post-purchase, "purchased" what the
// GraphQL enum calls the same state; rows arrive here from both.
const PRE_TRANSIT_STATUSES = ["created", "purchased"];

export async function markShippedAndMove(
  markShipped: {
    mutateAsync: (variables: { id: string }) => Promise<{ message: string }>;
  },
  changeStatus: {
    mutateAsync: (variables: {
      id: string;
      status: ManualShipmentStatusEnum;
      reason?: string;
    }) => Promise<unknown>;
  },
  shipment: { id: string; status?: string },
): Promise<{ message: string; moved: boolean }> {
  const { message } = await markShipped.mutateAsync({ id: shipment.id });
  if (!PRE_TRANSIT_STATUSES.includes(shipment.status || "")) {
    // The tracker already moved the row off the Picked card — the ERP write
    // (or its "already in transit" no-op) was all there was left to do.
    return { message, moved: true };
  }
  try {
    await changeStatus.mutateAsync({
      id: shipment.id,
      status: ManualShipmentStatusEnum.in_transit,
      reason: MARK_SHIPPED_STATUS_REASON,
    });
    return { message, moved: true };
  } catch {
    // Same contract as recordDeliveryOutcome: the ERP has the hand-over on
    // record, so a status-change refusal downgrades the toast, never the
    // action — the row simply moves when the carrier scans.
    return { message, moved: false };
  }
}

// The ERP mirrors its new erp_status back onto the Karrio shipment via a
// background job, so a refetch fired straight from onSuccess races that
// mirror: it usually still sees the OLD status and the row stays on the
// wrong card until something else refreshes. Long enough for the ERP's RQ
// job to land, short enough that the row moves while the operator is still
// looking at the list.
const ERP_MIRROR_GRACE_MS = 4000;

export function useShipmentERPActions(id?: string) {
  const queryClient = useQueryClient();
  const karrio = useKarrio();
  const invalidateCache = () => {
    queryClient.invalidateQueries(["shipments"]);
    queryClient.invalidateQueries(["shipments", id]);
  };
  // Twice on purpose: immediately (cheap, and correct for everything the
  // action changed server-side in Karrio itself) and once more after the
  // mirror grace period, so the refetch that decides which card the row
  // sits on sees the ERP-mirrored erp_status. No optimistic update — the
  // ERP is the source of truth for its own status.
  const invalidateAroundMirror = () => {
    invalidateCache();
    setTimeout(invalidateCache, ERP_MIRROR_GRACE_MS);
  };

  // Most actions are a bare POST; an action that needs arguments (the
  // delivery outcome carries its recorded reason) declares them as its
  // payload type and they are sent as the JSON body. An empty payload still
  // posts no body, so the existing actions are unchanged on the wire.
  const runAction = <Payload extends object = {}>(action: ERPShipmentAction) =>
    useMutation(
      ({ id, ...payload }: { id: string } & Payload) =>
        handleFailure(
          karrio.axios
            .post<{ message: string }>(
              `/v1/shipments/${id}/erp/${action}`,
              Object.keys(payload).length > 0 ? payload : undefined,
            )
            .then(({ data }) => data),
        ),
      { onSuccess: invalidateAroundMirror },
    );

  const markPicked = runAction("mark-picked");
  const unmarkPicked = runAction("unmark-picked");
  const markOutForDelivery = runAction("mark-out-for-delivery");
  // Moves the ERP row to "In Transit" once the carrier has the parcel.
  // Carrier path only, and the ERP requires status "Label Created" — a
  // purchased label, not a draft. Callers go through markShippedAndMove so
  // the Karrio status (and with it the dashboard card) follows immediately.
  const markShipped = runAction("mark-shipped");
  // Own-delivery only: the parcel was handed to the customer. The ERP is
  // strict (self_delivery + status "Out for Delivery") and this is the moment
  // the delivered write-back fires and Shopify mails the customer — which is
  // why the menu puts a confirmation dialog in front, not a reason prompt:
  // there is no carrier owning the status, so nothing is being overridden.
  const markDelivered = runAction("mark-delivered");
  // Deliberately NOT Karrio's own cancel: the ERP cancels the Karrio draft
  // itself, clears the address-review flag and reports back whether the Monta
  // order still has to be removed by hand — that note is the response
  // `message`, so callers should show it rather than a generic sentence.
  const cancelShipment = runAction("cancel-shipment");
  // Records how the delivery ended, with the operator's reason. The ERP is
  // where the reason is kept; the Karrio status is flipped separately by the
  // caller, and only after this write succeeded.
  const recordDeliveryOutcome = runAction<{
    outcome: DeliveryOutcome;
    note: string;
  }>("record-delivery-outcome");
  // The undo family only rewinds the ERP row — anything already sent stays
  // sent. The ERP spells out in its response message exactly what did NOT
  // get undone, so callers should surface that message, not a generic line.
  //
  // Mark-shipped was pure bookkeeping, so undoing it is too: In Transit →
  // Label Created, nothing customer-facing ever happened.
  const unmarkShipped = runAction("unmark-shipped");
  // Own-delivery only. Mark OFD created the Shopify fulfilment and mailed
  // the customer; this undo does NOT retract either — it only rewinds the
  // ERP status so the van run can be replanned.
  const unmarkOutForDelivery = runAction("unmark-out-for-delivery");
  // Own-delivery only. The delivered write-back and any customer mail stay
  // as they are; only the ERP's Delivered status is rewound.
  const unmarkDelivered = runAction("unmark-delivered");
  // Carrier path: erases the recorded outcome (and its reason) so a wrongly
  // filed delivery/failure/return can be re-recorded. The Karrio status is
  // NOT touched here — the caller moves the row back separately if needed.
  const undoDeliveryOutcome = runAction("undo-delivery-outcome");
  // Overrules Google's hint through the ERP's own Confirm-as-correct door:
  // the server re-validates live and only a Suspect verdict passes; the
  // release is Address-wide and audited with the mandatory reason.
  const confirmAddress = runAction<{ reason: string }>("confirm-address");

  return {
    markPicked,
    unmarkPicked,
    markOutForDelivery,
    markShipped,
    markDelivered,
    cancelShipment,
    recordDeliveryOutcome,
    unmarkShipped,
    unmarkOutForDelivery,
    unmarkDelivered,
    undoDeliveryOutcome,
    confirmAddress,
  };
}
