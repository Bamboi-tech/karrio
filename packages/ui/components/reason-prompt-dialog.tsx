"use client";

import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from "@karrio/ui/components/ui/alert-dialog";
import { Input } from "@karrio/ui/components/ui/input";
import { Label } from "@karrio/ui/components/ui/label";

interface ReasonPromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  fieldLabel?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // A promise keeps the dialog open — spinner on the button, fields locked —
  // until it settles, and only a fulfilled one closes it. A caller that
  // returns nothing gets the old behaviour: close at once.
  onConfirm: (reason: string) => void | Promise<unknown>;
  isLoading?: boolean;
  // What the button says while the promise is in flight.
  processingLabel?: string;
}

// Confirmation dialog that also collects a free-text reason. The reason is
// required: the whole point of the outcome actions is that the ERP records
// WHY a delivery ended the way it did, so an empty note is refused here
// rather than written as a blank.
export function ReasonPromptDialog({
  open,
  onOpenChange,
  title,
  description,
  fieldLabel = "Reason",
  placeholder = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  isLoading = false,
  processingLabel = "Processing...",
}: ReasonPromptDialogProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const busy = isLoading || submitting;

  const handleSubmit = async () => {
    if (busy) return;
    setError(null);
    const value = reason.trim();

    if (value.length === 0) {
      setError("A reason is required");
      return;
    }

    const result = onConfirm(value);
    if (!(result instanceof Promise)) {
      setReason("");
      onOpenChange(false);
      return;
    }

    // The action is a round trip to the ERP (the confirm-address relay
    // re-validates with Google, releases the order and rebuilds the draft
    // before it answers). The dialog used to close the instant the button
    // was pressed, so none of that had any visible sign of happening. Now it
    // stays up with the spinner; a rejection has already been toasted by the
    // caller, so the reason is kept for a retry.
    setSubmitting(true);
    try {
      await result;
      setReason("");
      onOpenChange(false);
    } catch {
      // reported by the caller
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <Label>{fieldLabel}</Label>
            <Input
              value={reason}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setReason(e.target.value)
              }
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder={placeholder}
              className="mt-1"
              disabled={busy}
              autoFocus
            />
            {error && <p className="text-xs text-destructive mt-1">{error}</p>}
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event: React.MouseEvent) => {
              // Radix closes the dialog on Action click unless the event is
              // prevented; the submit decides when to close.
              event.preventDefault();
              handleSubmit();
            }}
            disabled={busy || reason.trim().length === 0}
          >
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {processingLabel}
              </>
            ) : (
              confirmLabel
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default ReasonPromptDialog;
