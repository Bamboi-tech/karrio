import React from "react";
import type { AddressType, AddressReviewContext } from "@karrio/types";
import { Button } from "@karrio/ui/components/ui/button";

export const DELIVERY_FIELDS = [
  "address_line1",
  "address_line2",
  "postal_code",
  "city",
  "state_code",
  "country_code",
] as const;

export function addressIssue(
  current: Partial<AddressType>,
  suggested?: Partial<AddressType> | null,
) {
  if (!suggested) return "Check the delivery address before shipping.";
  if (current.postal_code !== suggested.postal_code)
    return "The postal code may be incorrect.";
  if (current.address_line1 !== suggested.address_line1)
    return "The street or house number may be incorrect.";
  if (current.city !== suggested.city) return "The city may be incorrect.";
  return "Check the highlighted address details.";
}

export function AddressSuggestion({
  current,
  review,
  busy,
  edited,
  onAccept,
  onDismiss,
}: {
  current: Partial<AddressType>;
  review: AddressReviewContext;
  busy: boolean;
  edited: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  if (["Valid", "Corrected", "Confirmed"].includes(review.status || "")) {
    return (
      <p className="rounded-lg border p-4 text-sm" role="status">
        The current address has no outstanding validation issues.
      </p>
    );
  }
  const suggested = review.suggested_address;
  const value = (field: (typeof DELIVERY_FIELDS)[number]) => {
    const changed = (current[field] || "") !== (suggested?.[field] || "");
    return (
      <span
        className={changed ? "bg-blue-100 text-blue-950 rounded px-0.5" : ""}
      >
        {suggested?.[field]}
      </span>
    );
  };
  return (
    <aside
      className="rounded-lg border bg-background p-4 space-y-3 self-start"
      aria-label="Suggested address"
    >
      <h3 className="font-semibold">Suggested address</h3>
      <p
        className="rounded-md bg-amber-50 text-amber-900 p-3 text-sm"
        role="status"
      >
        {addressIssue(current, suggested)}
      </p>
      {suggested && (
        <div className="rounded-md border p-3 text-sm space-y-1">
          <p>{current.person_name}</p>
          {current.company_name && <p>{current.company_name}</p>}
          <p>{value("address_line1")}</p>
          {(suggested.address_line2 || current.address_line2) && (
            <p>{value("address_line2")}</p>
          )}
          <p>
            {value("postal_code")} {value("city")}
          </p>
          {suggested.state_code && <p>{value("state_code")}</p>}
          <p>{value("country_code")}</p>
        </div>
      )}
      {!review.can_use_suggestion && (
        <p className="text-sm text-muted-foreground">
          This suggestion could not be fully verified. Check and edit the
          address manually.
        </p>
      )}
      {edited && (
        <p className="text-sm text-muted-foreground">
          The address has been edited. Save your changes to check it again.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {review.can_use_suggestion && (
          <Button
            type="button"
            size="sm"
            disabled={busy || edited}
            onClick={onAccept}
          >
            {busy ? "Saving…" : "Use suggestion"}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Dismissing keeps the current address and its validation status.
      </p>
      {review.summary && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Validation details</summary>
          <p className="mt-2">{review.summary}</p>
          {review.suggestion_summary && (
            <p className="mt-1">{review.suggestion_summary}</p>
          )}
        </details>
      )}
    </aside>
  );
}
