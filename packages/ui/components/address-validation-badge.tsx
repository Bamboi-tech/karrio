"use client";

import React from "react";
import { cn } from "@karrio/ui/lib/utils";

// Written onto the shipment metadata by the ERP (karrio_shipping) when Google
// Address Validation flags a delivery address. The draft is created without
// contacting a carrier, so these keys are the only signal in Karrio that the
// shipment is waiting on a human correction.
export const ADDRESS_REVIEW_FLAG = "address_review_required";
export const ADDRESS_STATUS_KEY = "address_validation_status";
export const ADDRESS_NOTE_KEY = "address_validation_note";
export const ADDRESS_SUGGESTION_KEY = "address_suggestion";
// Set on `meta` (not `metadata`) by the recipient mutation the moment an
// operator saves a corrected address, and gone once the ERP has re-validated
// and rebuilt the draft.
export const ADDRESS_SYNC_PENDING_KEY = "address_sync_pending";
// Written by the ERP (karrio_shipping.api.webhooks._finish_recipient_sync)
// on a draft whose recipient correction it could not apply — the draft keeps
// its previous verdict and this says why; nulled on the next success.
export const ADDRESS_SYNC_ERROR_KEY = "address_sync_error";
// Stamped by the ERP on a draft it voided during a re-sync, naming the draft
// that took its place (karrio_shipping._link_replaced_drafts). A correction
// or a confirm rebuilds the order as a NEW Karrio shipment; this is how the
// page the operator is still on leads them to it.
export const REPLACED_BY_KEY = "replaced_by_shipment";

export const PENDING_STATUS = "validating";
// Written by the ERP (karrio_shipping._address_history) on every draft of an
// order whose address a person corrected or confirmed; the note carries who,
// when and why, with Google's verdict beneath it.
export const CORRECTED_STATUS = "corrected";

export function isCorrected(status?: string | null): boolean {
  return (status || "").toLowerCase() === CORRECTED_STATUS;
}

export interface AddressReview {
  status: string;
  note?: string;
  suggestion?: string;
  // The ERP's reason for refusing the last recipient correction, if any.
  error?: string;
  // A saved correction is on its way through ERP validation. The stored verdict
  // still describes the *previous* address, so it must not be shown.
  pending: boolean;
}

// `metadata`/`meta` are untyped JSON scalars on the GraphQL schema, so every
// key is narrowed here rather than trusted by the callers.
export function getAddressReview(
  metadata: unknown,
  meta?: unknown,
): AddressReview | null {
  const pending = Boolean(
    ((meta || {}) as Record<string, unknown>)[ADDRESS_SYNC_PENDING_KEY],
  );
  const values = (metadata || {}) as Record<string, unknown>;
  const status = values[ADDRESS_STATUS_KEY];
  const hasStatus = typeof status === "string" && status.length > 0;
  const error = asText(values[ADDRESS_SYNC_ERROR_KEY]);

  if (!hasStatus && !pending && !error) return null;
  if (pending) return { status: PENDING_STATUS, pending: true };

  return {
    // A refused correction on a draft that carried no verdict still needs a
    // row to hang the refusal on.
    status: hasStatus ? (status as string) : "unchecked",
    note: asText(values[ADDRESS_NOTE_KEY]),
    suggestion: asText(values[ADDRESS_SUGGESTION_KEY]),
    error,
    pending: false,
  };
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// The id of the draft that replaced this one, when the ERP has linked it.
export function getReplacement(metadata: unknown): string | null {
  return (
    asText(((metadata || {}) as Record<string, unknown>)[REPLACED_BY_KEY]) ||
    null
  );
}

interface AddressValidationBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status?: string;
}

export const AddressValidationBadge = ({
  status,
  className,
  ...props
}: AddressValidationBadgeProps): JSX.Element => {
  const getStatusStyles = (status: string) => {
    const styles = {
      invalid: "bg-red-50 text-red-500",
      suspect: "bg-yellow-50 text-yellow-600",
      unchecked: "bg-gray-50 text-gray-500",
      valid: "bg-green-50 text-green-500",
      // A person fixed or confirmed this address (the ERP stamps it on every
      // later draft of the order): green, and it stays through Completed so
      // the rows the warehouse corrected remain recognisable.
      [CORRECTED_STATUS]: "bg-green-50 text-green-600",
      [PENDING_STATUS]: "bg-blue-50 text-blue-500",
    };

    return (
      styles[status.toLowerCase() as keyof typeof styles] ||
      "bg-gray-50 text-gray-500"
    );
  };

  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-1 rounded text-xs font-semibold",
        getStatusStyles(status || ""),
        className,
      )}
      {...props}
    >
      {(status || "").toLocaleLowerCase()}
    </span>
  );
};

AddressValidationBadge.displayName = "AddressValidationBadge";
