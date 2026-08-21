"use client";

import {
  ManualShipmentStatusEnum,
  ShipmentStatusEnum,
  DocumentTemplateType,
  ShipmentType,
} from "@karrio/types";
import { useDocumentTemplates } from "@karrio/hooks/document-template";
import { useDocumentPrinter, FormatType } from "@karrio/hooks/resource-token";
import { errorToMessages, formatRef, isNone, isNoneOrEmpty, p } from "@karrio/lib";
import { useShipmentMutation } from "@karrio/hooks/shipment";
import {
  useShipmentERPActions,
  isERPLinked,
  getERPStatus,
} from "@karrio/hooks/erp-actions";
import { useBamboiFeatures } from "@karrio/hooks/bamboi-features";
import { getShopifyHold, shopifyHoldTooltip } from "./shipment-hold";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { useAppMode } from "@karrio/hooks/app-mode";
import { useToast } from "@karrio/ui/hooks/use-toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Button } from "./ui/button";
import { MoreHorizontal } from "lucide-react";

interface ShipmentMenuComponent
  extends React.InputHTMLAttributes<HTMLDivElement> {
  shipment: ShipmentType;
  templates?: DocumentTemplateType[];
  isViewing?: boolean;
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
}

export const ShipmentMenu = ({
  shipment,
  isViewing,
  variant = "ghost",
}: ShipmentMenuComponent): JSX.Element => {
  const router = useRouter();
  const { basePath } = useAppMode();
  const mutation = useShipmentMutation();
  const documentPrinter = useDocumentPrinter();
  const { toast } = useToast();
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => Promise<any>;
  } | null>(null);
  const {
    query: { data: { document_templates } = {} },
  } = useDocumentTemplates({
    related_object: "shipment",
    active: true,
  } as any);
  const shopifyHold = getShopifyHold(shipment.metadata);
  // Bamboi fork: warehouse actions relayed to the ERP (Ship Today phase 2).
  // The ERP enforces its own gates; a refusal (hold, wrong status) surfaces
  // as a toast with the ERP's own message.
  const erpActions = useShipmentERPActions(shipment.id);
  // Feature flags come from the ERP registry; until they load, isEnabled
  // answers from the identical client-side defaults, so the menu renders the
  // same before and after the fetch — no flicker.
  const { isEnabled } = useBamboiFeatures();
  const erpLinked = isERPLinked(shipment.metadata);
  const erpStatus = getERPStatus(shipment.metadata);
  const erpSelfDelivery =
    ((shipment.metadata || {}) as Record<string, unknown>)["fulfilment_mode"] ===
    "self_delivery";

  const runERPAction =
    (mutation: typeof erpActions.markPicked, title: string) => async () => {
      try {
        const { message } = await mutation.mutateAsync({ id: shipment.id });
        toast({ title, description: message });
      } catch (error: any) {
        const messages = errorToMessages(error);
        toast({
          variant: "destructive",
          title: `${title} failed`,
          description: messages
            .map((m: any) => (typeof m === "string" ? m : m.message || JSON.stringify(m)))
            .join("; "),
        });
        // Re-throw so a confirmation dialog stays open for retry.
        throw error;
      }
    };

  const createLabel = (_: React.MouseEvent) => {
    toast({
      title: "Opening create label page...",
      description: "Taking you to create a label for this shipment.",
    });

    if (!!shipment.meta?.orders) {
      router.push(
        p`${basePath}/orders/create_label?shipment_id=${shipment.id}&order_id=${shipment.meta.orders}`,
      );
    } else {
      router.push(p`${basePath}/create_label?shipment_id=${shipment.id}`);
    }
  };

  const displayDetails = (_: React.MouseEvent) => {
    router.push(p`${basePath}/shipments/${shipment.id}`);
  };

  const cancelShipment = (shipment: ShipmentType) => async () => {
    try {
      await mutation.voidLabel.mutateAsync(shipment);

      toast({
        title: "Shipment cancelled successfully",
        description: `Shipment ${shipment.tracking_number || shipment.id} has been cancelled.`,
      });
    } catch (error: any) {
      const messages = errorToMessages(error);
      toast({
        variant: "destructive",
        title: "Failed to cancel shipment",
        description: messages
          .map((m: any) => (typeof m === "string" ? m : m.message || JSON.stringify(m)))
          .join("; "),
      });

      // Re-throw to prevent dialog from closing
      throw error;
    }
  };

  const changeStatus =
    ({ id }: ShipmentType, status: ManualShipmentStatusEnum) =>
      async () => {
        try {
          await mutation.changeStatus.mutateAsync({ id, status });

          toast({
            title: "Status updated successfully",
            description: `Shipment has been marked as ${formatRef(status.toString())}.`,
          });
        } catch (error: any) {
          const messages = errorToMessages(error);
          toast({
            variant: "destructive",
            title: "Failed to update status",
            description: messages
              .map((m: any) => (typeof m === "string" ? m : m.message || JSON.stringify(m)))
              .join("; "),
          });

          // Re-throw to prevent dialog from closing
          throw error;
        }
      };

  const duplicateShipment = async (_: React.MouseEvent) => {
    toast({
      title: "Creating duplicate shipment...",
      description: "Please wait while we duplicate your shipment.",
    });

    try {
      console.log("> duplicating shipment...");
      const duplicatedShipment =
        await mutation.duplicateShipment.mutateAsync(shipment);
      console.log("> shipment duplicate created successfully!");

      toast({
        title: "Shipment duplicated successfully!",
        description: "Opening create label page for the new shipment.",
      });

      router.push(
        p`${basePath}/create_label?shipment_id=${duplicatedShipment.id}`,
      );
    } catch (error) {
      console.error("Failed to duplicate shipment:", error);
      toast({
        variant: "destructive",
        title: "Failed to duplicate shipment",
        description: "Please try again or contact support if the issue persists.",
      });
    }
  };

  const handleConfirm = async () => {
    if (!confirmAction) return;

    try {
      await confirmAction.onConfirm();
      setConfirmDialogOpen(false);
      setConfirmAction(null);
    } catch (error) {
      console.error('Confirmation action failed:', error);
      // Dialog stays open for retry
    }
  };

  return (
    <div key={`menu-${shipment.id}`}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={variant}
            size="icon"
            className="h-8 w-8 p-0 hover:bg-muted"
          >
            <MoreHorizontal className="h-4 w-4" />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-56"
          id={`shipment-menu-${shipment.id}`}
          role="menu"
        >

          {!isViewing && (
            <DropdownMenuItem onClick={displayDetails}>
              <span>View Shipment</span>
            </DropdownMenuItem>
          )}

          {/* A draft whose Shopify order is on hold cannot buy a label.
              UI courtesy only: it saves the operator a dead-end trip to the
              create_label page — the authoritative enforcement lives in the
              ERP's gates (karrio_shipping) and, phase 2, in the Karrio
              server. The wrapping span carries the tooltip because a
              disabled Radix item swallows pointer events. */}
          {isNone(shipment.label_url) &&
            shipment.status === ShipmentStatusEnum.draft &&
            // The flag only governs the ERP-managed flow; a plain Karrio
            // shipment keeps its Buy Label regardless.
            (!erpLinked || isEnabled("btn_buy_label_dashboard")) &&
            (shopifyHold.held ? (
              <span title={shopifyHoldTooltip(shopifyHold)}>
                <DropdownMenuItem disabled>
                  <span>Buy Label</span>
                </DropdownMenuItem>
              </span>
            ) : (
              <DropdownMenuItem onClick={createLabel}>
                <span>Buy Label</span>
              </DropdownMenuItem>
            ))}

          {/* Bamboi fork: ERP warehouse actions. Visibility follows the
              mirrored erp_status; the ERP re-checks its own gates on every
              call, so a stale mirror can only hide a button, never bypass a
              rule. Mark picked / undo are reversible — no dialog. */}
          {erpLinked && erpStatus === "Synced" && isEnabled("btn_mark_picked") && (
            <DropdownMenuItem
              onClick={runERPAction(erpActions.markPicked, "Mark picked")}
              disabled={erpActions.markPicked.isLoading}
            >
              <span>Mark Picked (ERP)</span>
            </DropdownMenuItem>
          )}

          {erpLinked && erpStatus === "Picked" && isEnabled("undo_pick") && (
            <DropdownMenuItem
              onClick={runERPAction(erpActions.unmarkPicked, "Undo pick")}
              disabled={erpActions.unmarkPicked.isLoading}
            >
              <span>Undo Pick (ERP)</span>
            </DropdownMenuItem>
          )}

          {/* Irreversible: creates the Shopify fulfillment and notifies the
              customer — always behind a confirmation dialog. Only offered on
              own-delivery shipments (metadata.fulfilment_mode, stamped by the
              ERP sync); legacy drafts without the key keep using the ERP
              button. */}
          {erpLinked &&
            erpSelfDelivery &&
            isEnabled("btn_mark_out_for_delivery") &&
            ["Synced", "Picked"].includes(erpStatus || "") && (
              <DropdownMenuItem
                onClick={() => {
                  setConfirmAction({
                    title: "Mark Out for Delivery",
                    description:
                      "The parcel leaves on our own van: this creates the Shopify fulfillment and notifies the customer. This cannot be undone.",
                    confirmLabel: "Mark Out for Delivery",
                    onConfirm: runERPAction(
                      erpActions.markOutForDelivery,
                      "Mark out for delivery",
                    ),
                  });
                  setConfirmDialogOpen(true);
                }}
                disabled={erpActions.markOutForDelivery.isLoading}
              >
                <span>Mark Out for Delivery (ERP)</span>
              </DropdownMenuItem>
            )}

          {/* Carrier path bookkeeping: the parcel is with the carrier, so the
              ERP row moves to In Transit. Not customer-facing (no Shopify
              fulfillment, no mail) and the ERP re-checks the status gate, so
              no confirmation dialog. */}
          {erpLinked && erpStatus === "Label Created" && isEnabled("btn_mark_shipped") && (
            <DropdownMenuItem
              onClick={runERPAction(erpActions.markShipped, "Mark shipped")}
              disabled={erpActions.markShipped.isLoading}
            >
              <span>Mark Shipped (ERP)</span>
            </DropdownMenuItem>
          )}

          {/* Undo family. Reversible bookkeeping undos go without a dialog;
              anything whose forward action already told the customer
              something gets a confirmation spelling out what stays sent.
              The ERP's response message repeats that, and the toast quotes
              it. */}

          {/* Mark Shipped was carrier-path bookkeeping, so its undo is too:
              In Transit → Label Created, nothing customer-facing. */}
          {erpLinked && erpStatus === "In Transit" && isEnabled("undo_shipped") && (
            <DropdownMenuItem
              onClick={runERPAction(erpActions.unmarkShipped, "Undo shipped")}
              disabled={erpActions.unmarkShipped.isLoading}
            >
              <span>Undo Shipped (ERP)</span>
            </DropdownMenuItem>
          )}

          {/* Own delivery only. Mark OFD created the Shopify fulfilment and
              mailed the customer — the undo rewinds the ERP status but can
              retract neither, hence the dialog. */}
          {erpLinked &&
            erpSelfDelivery &&
            erpStatus === "Out for Delivery" &&
            isEnabled("undo_out_for_delivery") && (
              <DropdownMenuItem
                onClick={() => {
                  setConfirmAction({
                    title: "Undo Out for Delivery",
                    description:
                      "The Shopify fulfillment was already created and the customer was already notified — neither is retracted. This only moves the ERP row back so the delivery run can be replanned.",
                    confirmLabel: "Undo Out for Delivery",
                    onConfirm: runERPAction(
                      erpActions.unmarkOutForDelivery,
                      "Undo out for delivery",
                    ),
                  });
                  setConfirmDialogOpen(true);
                }}
                disabled={erpActions.unmarkOutForDelivery.isLoading}
              >
                <span>Undo Out for Delivery (ERP)</span>
              </DropdownMenuItem>
            )}

          {/* Own delivery only. The delivered write-back and customer mail
              stay as they are; only the ERP's Delivered status is rewound. */}
          {erpLinked &&
            erpSelfDelivery &&
            erpStatus === "Delivered" &&
            isEnabled("undo_delivered") && (
              <DropdownMenuItem
                onClick={() => {
                  setConfirmAction({
                    title: "Undo Delivered",
                    description:
                      "The delivered write-back to Shopify and any customer notification already went out and stay as they are. This only rewinds the ERP row to Out for Delivery.",
                    confirmLabel: "Undo Delivered",
                    onConfirm: runERPAction(
                      erpActions.unmarkDelivered,
                      "Undo delivered",
                    ),
                  });
                  setConfirmDialogOpen(true);
                }}
                disabled={erpActions.unmarkDelivered.isLoading}
              >
                <span>Undo Delivered (ERP)</span>
              </DropdownMenuItem>
            )}

          {/* Carrier path: a wrongly recorded outcome (delivered / failed /
              returned) can be erased and re-recorded. Also offered when the
              Karrio row was parked on needs_attention while the ERP still
              says In Transit — the mismatch that a mis-filed outcome leaves
              behind. Confirmed because it erases the recorded reason. */}
          {erpLinked &&
            !erpSelfDelivery &&
            isEnabled("undo_delivery_outcome") &&
            (["Delivered", "Delivery Failed", "Returned"].includes(
              erpStatus || "",
            ) ||
              (erpStatus === "In Transit" &&
                (shipment.status as any) ===
                  ManualShipmentStatusEnum.needs_attention)) && (
              <DropdownMenuItem
                onClick={() => {
                  setConfirmAction({
                    title: "Undo Delivery Outcome",
                    description:
                      "This erases the recorded outcome and its reason from the ERP so it can be re-recorded. Anything already written back to Shopify stays as it is, and the Karrio status is not changed here.",
                    confirmLabel: "Undo Outcome",
                    onConfirm: runERPAction(
                      erpActions.undoDeliveryOutcome,
                      "Undo delivery outcome",
                    ),
                  });
                  setConfirmDialogOpen(true);
                }}
                disabled={erpActions.undoDeliveryOutcome.isLoading}
              >
                <span>Undo Delivery Outcome (ERP)</span>
              </DropdownMenuItem>
            )}

          {!isNone(shipment.label_url) && (
            <DropdownMenuItem
              onClick={() => documentPrinter.openShipmentLabel(
                shipment.id,
                { format: (shipment.label_type || "pdf").toLowerCase() as FormatType, doc: "label" }
              )}
              disabled={documentPrinter.isLoading}
            >
              <span>Print Label</span>
            </DropdownMenuItem>
          )}

          {!isNone(shipment.invoice_url) && (
            <DropdownMenuItem
              onClick={() => documentPrinter.openShipmentLabel(
                shipment.id,
                { format: "pdf", doc: "invoice" }
              )}
              disabled={documentPrinter.isLoading}
            >
              <span>Print Invoice</span>
            </DropdownMenuItem>
          )}

          <DropdownMenuItem onClick={duplicateShipment}>
            <span>Duplicate Shipment</span>
          </DropdownMenuItem>

          {![
            ShipmentStatusEnum.cancelled,
            ShipmentStatusEnum.delivered,
          ].includes(shipment.status as any) && (
              <DropdownMenuItem
                onClick={() => {
                  setConfirmAction({
                    title: "Cancel Shipment",
                    description: `Are you sure you want to cancel shipment ${shipment.id}? This action cannot be undone.`,
                    confirmLabel: "Submit",
                    onConfirm: cancelShipment(shipment),
                  });
                  setConfirmDialogOpen(true);
                }}
                className="text-destructive focus:text-destructive"
              >
                <span>Cancel Shipment</span>
              </DropdownMenuItem>
            )}

          {shipment.carrier_name &&
            isNoneOrEmpty(shipment.tracker_id) &&
            ![
              ShipmentStatusEnum.cancelled,
              ShipmentStatusEnum.delivered,
              ManualShipmentStatusEnum.delivery_failed,
            ].includes(shipment.status as any) && (
              <>
                <DropdownMenuSeparator />

                {shipment.status === ShipmentStatusEnum.created && (
                  <DropdownMenuItem
                    onClick={() => {
                      setConfirmAction({
                        title: "Update Shipment Status",
                        description: `Mark shipment ${shipment.id} as ${formatRef(ManualShipmentStatusEnum.in_transit.toString())}?`,
                        confirmLabel: "Apply",
                        onConfirm: changeStatus(
                          shipment,
                          ManualShipmentStatusEnum.in_transit,
                        ),
                      });
                      setConfirmDialogOpen(true);
                    }}
                  >
                    <span>Mark as {formatRef(ManualShipmentStatusEnum.in_transit.toString())}</span>
                  </DropdownMenuItem>
                )}

                {[
                  ShipmentStatusEnum.created,
                  ShipmentStatusEnum.in_transit,
                ].includes(shipment.status as any) && (
                    <DropdownMenuItem
                      onClick={() => {
                        setConfirmAction({
                          title: "Update Shipment Status",
                          description: `Mark shipment ${shipment.id} as ${formatRef(ManualShipmentStatusEnum.needs_attention.toString())}?`,
                          confirmLabel: "Save",
                          onConfirm: changeStatus(
                            shipment,
                            ManualShipmentStatusEnum.needs_attention,
                          ),
                        });
                        setConfirmDialogOpen(true);
                      }}
                    >
                      <span>Mark as {formatRef(ManualShipmentStatusEnum.needs_attention.toString())}</span>
                    </DropdownMenuItem>
                  )}

                {[
                  ShipmentStatusEnum.created,
                  ShipmentStatusEnum.in_transit,
                  ShipmentStatusEnum.needs_attention,
                ].includes(shipment.status as any) && (
                    <DropdownMenuItem
                      onClick={() => {
                        setConfirmAction({
                          title: "Update Shipment Status",
                          description: `Mark shipment ${shipment.id} as ${formatRef(ManualShipmentStatusEnum.delivery_failed.toString())}?`,
                          confirmLabel: "Save",
                          onConfirm: changeStatus(
                            shipment,
                            ManualShipmentStatusEnum.delivery_failed,
                          ),
                        });
                        setConfirmDialogOpen(true);
                      }}
                    >
                      <span>Mark as {formatRef(ManualShipmentStatusEnum.delivery_failed.toString())}</span>
                    </DropdownMenuItem>
                  )}

                {[
                  ShipmentStatusEnum.created,
                  ShipmentStatusEnum.in_transit,
                  ShipmentStatusEnum.needs_attention,
                ].includes(shipment.status as any) && (
                    <DropdownMenuItem
                      onClick={() => {
                        setConfirmAction({
                          title: "Update Shipment Status",
                          description: `Mark shipment ${shipment.id} as ${formatRef(ManualShipmentStatusEnum.delivered.toString())}?`,
                          confirmLabel: "Save",
                          onConfirm: changeStatus(
                            shipment,
                            ManualShipmentStatusEnum.delivered,
                          ),
                        });
                        setConfirmDialogOpen(true);
                      }}
                    >
                      <span>Mark as {formatRef(ManualShipmentStatusEnum.delivered.toString())}</span>
                    </DropdownMenuItem>
                  )}
              </>
            )}

          {(document_templates?.edges || []).length > 0 && (
            <DropdownMenuSeparator />
          )}

          {(document_templates?.edges || []).map(({ node: template }) => (
            <DropdownMenuItem
              key={template.id}
              onClick={() => documentPrinter.openTemplate(
                template.id,
                { shipments: shipment.id }
              )}
              disabled={documentPrinter.isLoading}
            >
              <span>Download {template.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {confirmAction && (
        <DeleteConfirmationDialog
          open={confirmDialogOpen}
          onOpenChange={setConfirmDialogOpen}
          title={confirmAction.title}
          description={confirmAction.description}
          confirmLabel={confirmAction.title === "Cancel Shipment" ? "Cancel" : confirmAction.confirmLabel}
          cancelLabel={confirmAction.title === "Cancel Shipment" ? "Go Back" : "Cancel"}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  );
};
