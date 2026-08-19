import { useMutation, useQueryClient } from "@tanstack/react-query";
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
  | "mark-shipped";

export function isERPLinked(metadata: unknown): boolean {
  const values = (metadata || {}) as Record<string, unknown>;
  return ERP_LINK_KEYS.some((key) => key in values);
}

export function getERPStatus(metadata: unknown): string | null {
  const values = (metadata || {}) as Record<string, unknown>;
  const status = values["erp_status"];
  return typeof status === "string" && status.length > 0 ? status : null;
}

export function useShipmentERPActions(id?: string) {
  const queryClient = useQueryClient();
  const karrio = useKarrio();
  const invalidateCache = () => {
    queryClient.invalidateQueries(["shipments"]);
    queryClient.invalidateQueries(["shipments", id]);
  };

  const runAction = (action: ERPShipmentAction) =>
    useMutation(
      ({ id }: { id: string }) =>
        handleFailure(
          karrio.axios
            .post<{ message: string }>(`/v1/shipments/${id}/erp/${action}`)
            .then(({ data }) => data),
        ),
      { onSuccess: invalidateCache },
    );

  const markPicked = runAction("mark-picked");
  const unmarkPicked = runAction("unmark-picked");
  const markOutForDelivery = runAction("mark-out-for-delivery");
  // Bookkeeping only: moves the ERP row to "In Transit" once the carrier has
  // the parcel. Carrier path only, and the ERP requires status
  // "Label Created" — a purchased label, not a draft.
  const markShipped = runAction("mark-shipped");

  return {
    markPicked,
    unmarkPicked,
    markOutForDelivery,
    markShipped,
  };
}
