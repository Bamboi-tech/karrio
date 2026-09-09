import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@karrio/ui/components/ui/dialog";
import { AddressType, ShipmentType } from "@karrio/types";
import { AddressForm } from "@karrio/ui/components/address-form";
import { Button } from "@karrio/ui/components/ui/button";
import { Loader2 } from "lucide-react";
import { COUNTRY_WITH_POSTAL_CODE, isEqual } from "@karrio/lib";
import { useAddressReview } from "@karrio/hooks/address";
import {
  AddressSuggestion,
  DELIVERY_FIELDS,
  distinctAddressSuggestion,
} from "@karrio/ui/components/address-suggestion";
import { useAPIMetadata } from "@karrio/hooks/api-metadata";

export interface AddressEditDialogProps {
  header?: string;
  shipment?: ShipmentType;
  address: AddressType | ShipmentType["recipient"] | ShipmentType["shipper"];
  onSubmit: (address: AddressType) => Promise<any>;
  trigger: React.ReactElement;
  mode?: "full" | "delivery";
  description?: string;
}

export const AddressEditDialog = ({
  trigger,
  header,
  shipment,
  address,
  onSubmit,
  mode = "full",
  description,
}: AddressEditDialogProps): JSX.Element => {
  const { references } = useAPIMetadata();
  const [isOpen, setIsOpen] = useState(false);
  const [currentAddress, setCurrentAddress] = useState<Partial<AddressType>>(
    address || {},
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const reviewEnabled =
    mode === "delivery" && !!shipment?.metadata?.sales_order;
  const review = useAddressReview(shipment?.id, isOpen && reviewEnabled);
  const edited = DELIVERY_FIELDS.some(
    (field) => (currentAddress[field] || "") !== (address[field] || ""),
  );
  const formRef = React.useRef<any>(null);

  React.useEffect(() => {
    setCurrentAddress(address || {});
  }, [address]);

  const handleSubmit = async (data: Partial<AddressType>) => {
    try {
      setSaveError(null);
      await onSubmit(data as AddressType);
      setIsOpen(false);
    } catch (error) {
      // Error is handled by the AddressForm component
      setSaveError("The address could not be saved. Please try again.");
    }
  };

  const acceptSuggestion = async () => {
    if (
      !review.data?.can_use_suggestion ||
      !distinctAddressSuggestion(currentAddress, review.data.suggested_address) ||
      review.isFetching ||
      edited
    )
      return;
    setIsSubmitting(true);
    try {
      await handleSubmit({
        ...currentAddress,
        ...review.data.suggested_address,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFooterSubmit = async () => {
    if (formRef.current) {
      setIsSubmitting(true);
      try {
        await formRef.current.submit();
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  const handleChange = (updatedAddress: Partial<AddressType>) => {
    setCurrentAddress(updatedAddress);
  };

  // Original validation logic from address form
  const isPostalRequired = COUNTRY_WITH_POSTAL_CODE.includes(
    currentAddress.country_code || "",
  );
  const isStateRequired = Object.keys(references.states || {}).includes(
    currentAddress.country_code || "",
  );

  const missingRequired =
    !currentAddress.person_name ||
    !currentAddress.country_code ||
    !currentAddress.address_line1 ||
    !currentAddress.city ||
    (isPostalRequired && !currentAddress.postal_code) ||
    (isStateRequired && !currentAddress.state_code);

  // Allow saving if there are changes OR if address has meaningful content (for new addresses)
  const hasChanges =
    !isEqual(address, currentAddress) ||
    currentAddress.person_name ||
    currentAddress.country_code ||
    currentAddress.address_line1 ||
    currentAddress.city;

  // Enhanced postal code validation (copied from address form)
  const validatePostalCode = (postal: string, country: string) => {
    if (!postal || !isPostalRequired) return true;

    const patterns: Record<string, RegExp> = {
      US: /^\d{5}(-\d{4})?$/,
      CA: /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/,
      GB: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i,
      DE: /^\d{5}$/,
      FR: /^\d{5}$/,
      AU: /^\d{4}$/,
      JP: /^\d{3}-\d{4}$/,
    };

    return patterns[country]?.test(postal) ?? true;
  };

  const isPostalValid = validatePostalCode(
    currentAddress.postal_code || "",
    currentAddress.country_code || "",
  );

  return (
    <>
      {React.cloneElement(trigger, {
        onClick: () => {
          setCurrentAddress(address || {});
          setDismissed(false);
          setSaveError(null);
          setIsOpen(true);
        },
      })}

      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!isSubmitting) setIsOpen(open);
        }}
      >
        <DialogContent
          className={`${reviewEnabled ? "max-w-4xl" : "max-w-2xl"} max-h-[90vh] flex flex-col`}
        >
          <DialogHeader className="sticky top-0 bg-white z-10 pb-4 border-b">
            <DialogTitle className="text-lg font-semibold">
              {header || "Edit address"}
            </DialogTitle>
            {description && (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </DialogHeader>

          <div
            className={`flex-1 overflow-y-auto mt-4 pb-6 px-4 ${reviewEnabled ? "grid md:grid-cols-[minmax(0,1fr)_300px] gap-6" : ""}`}
          >
            <div>
              {reviewEnabled && (
                <h3 className="font-semibold mb-3">Current address</h3>
              )}
              <AddressForm
                ref={formRef}
                value={currentAddress}
                onChange={handleChange}
                onSubmit={handleSubmit}
                showSubmitButton={false}
                mode={mode}
              />
            </div>
            {reviewEnabled && (
              <div>
                {review.isFetching ? (
                  <p className="text-sm text-muted-foreground" role="status">
                    Checking address and suggestion…
                  </p>
                ) : review.isError ? (
                  <div className="text-sm space-y-2" role="alert">
                    <p>
                      The address checker is unavailable. You can still edit and
                      save the address.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => review.refetch()}
                    >
                      Try again
                    </Button>
                  </div>
                ) : (
                  review.data &&
                  !dismissed && (
                    <AddressSuggestion
                      current={address}
                      review={review.data}
                      busy={isSubmitting}
                      edited={edited}
                      onAccept={acceptSuggestion}
                      onDismiss={() => setDismissed(true)}
                    />
                  )
                )}
              </div>
            )}
          </div>

          {saveError && (
            <p className="px-4 text-sm text-red-600" role="alert">
              {saveError}
            </p>
          )}

          {/* Sticky Footer */}
          <DialogFooter className="px-4 py-3 border-t sticky bottom-0 bg-background">
            <Button
              type="button"
              variant="outline"
              disabled={isSubmitting}
              onClick={() => setIsOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleFooterSubmit}
              disabled={
                isSubmitting ||
                !hasChanges ||
                missingRequired ||
                (Boolean(currentAddress.postal_code) && !isPostalValid)
              }
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Address"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

AddressEditDialog.displayName = "AddressEditDialog";
