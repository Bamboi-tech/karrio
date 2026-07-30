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

export interface AddressReview {
  status: string;
  note?: string;
  suggestion?: string;
}

// `metadata` is an untyped JSON scalar on the GraphQL schema, so every key is
// narrowed here rather than trusted by the callers.
export function getAddressReview(metadata: unknown): AddressReview | null {
  const values = (metadata || {}) as Record<string, unknown>;
  const status = values[ADDRESS_STATUS_KEY];
  if (typeof status !== "string" || status.length === 0) return null;

  const note = values[ADDRESS_NOTE_KEY];
  const suggestion = values[ADDRESS_SUGGESTION_KEY];

  return {
    status,
    note: typeof note === "string" ? note : undefined,
    suggestion: typeof suggestion === "string" ? suggestion : undefined,
  };
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
