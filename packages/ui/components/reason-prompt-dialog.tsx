"use client";

import React, { useState } from "react";
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
  onConfirm: (reason: string) => void;
  isLoading?: boolean;
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
}: ReasonPromptDialogProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    setError(null);
    const value = reason.trim();

    if (value.length === 0) {
      setError("A reason is required");
      return;
    }

    onConfirm(value);
    setReason("");
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
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
              autoFocus
            />
            {error && <p className="text-xs text-destructive mt-1">{error}</p>}
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleSubmit}
            disabled={isLoading || reason.trim().length === 0}
          >
            {isLoading ? "Processing..." : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default ReasonPromptDialog;
