"use client";
import React from "react";
import { MapPin, Pencil, AlertTriangle, Loader2 } from "lucide-react";
import type { AddressType, UpdateAddressInput, ShipmentType } from "@karrio/types";
import { useAddressReview } from "@karrio/hooks/address";
import { useShipmentMutation } from "@karrio/hooks/shipment";
import { useAPIMetadata } from "@karrio/hooks/api-metadata";
import { Popover, PopoverTrigger, PopoverContent } from "@karrio/ui/components/ui/popover";
import { AddressEditDialog } from "@karrio/ui/components/address-edit-dialog";
import { Button } from "@karrio/ui/components/ui/button";
import { getAddressReview } from "@karrio/ui/components/address-validation-badge";
import { addressIssue, DELIVERY_FIELDS } from "@karrio/ui/components/address-suggestion";

type ReviewShipment = { id: string; status: string; recipient: Partial<AddressType>; metadata?: unknown; meta?: unknown };

export function AddressReviewPopover({ shipment, onEdit }: { shipment: ReviewShipment; onEdit: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [choice, setChoice] = React.useState("suggestion");
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const state = getAddressReview(shipment.metadata, shipment.meta);
  const linked = !!(shipment.metadata as Record<string, unknown>)?.sales_order;
  const review = useAddressReview(shipment.id, open && linked && !state?.pending && !saved);
  const { updateShipment } = useShipmentMutation(shipment.id);
  const { references } = useAPIMetadata();
  const current = shipment.recipient;
  const suggestion = review.data?.suggested_address;
  const resolved = ["valid", "corrected", "confirmed"].includes((review.data?.status || state?.status || "").toLowerCase());
  const actionable = shipment.status === "draft" && !state?.pending && !saved && !resolved;
  const busy = updateShipment.isLoading;
  React.useEffect(() => {
    if (["valid", "corrected", "confirmed"].includes((state?.status || "").toLowerCase())) setSaved(false);
  }, [state?.status]);
  const address = (value: Partial<AddressType>, proposed: boolean) => {
    const field = (key: typeof DELIVERY_FIELDS[number]) => {
      const changed = suggestion && (current[key] || "") !== (suggestion[key] || "");
      const text = key === "country_code" ? references.countries?.[value.country_code || ""] || value.country_code : value[key];
      return <span className={changed ? proposed ? "bg-blue-100 rounded px-0.5" : "bg-amber-100 rounded px-0.5" : ""}>{text as string}</span>;
    };
    return <div className="text-sm leading-5">
      {current.person_name && <div>{current.person_name}</div>}
      {current.company_name && current.company_name !== current.person_name && <div>{current.company_name}</div>}
      <div>{field("address_line1")}</div>
      {value.address_line2 && <div>{field("address_line2")}</div>}
      <div>{field("postal_code")} {field("city")}</div>
      {value.state_code && <div>{field("state_code")}</div>}
      <div>{field("country_code")}</div>
    </div>;
  };
  const saveAddress = async (value: Partial<AddressType>) => {
    if (!current.id) throw new Error("The recipient address could not be resolved.");
    const result = await updateShipment.mutateAsync({ id: shipment.id, recipient: { ...value, id: current.id } as UpdateAddressInput });
    const errors = result.partial_shipment_update.errors;
    if (errors?.length) throw new Error(errors.flatMap(item => item.messages).join(" "));
    setSaved(true);
  };
  const accept = async () => {
    if (!actionable || !review.data?.can_use_suggestion || !suggestion || review.isFetching || busy || choice !== "suggestion") return;
    setError(null);
    try {
      if (!current.id) throw new Error("The recipient address could not be resolved.");
      const fields = Object.fromEntries(DELIVERY_FIELDS.filter(key => suggestion[key] !== undefined).map(key => [key, suggestion[key]]));
      await saveAddress({ ...current, ...fields });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The address could not be saved. Please try again."); }
  };
  return <Popover open={open} onOpenChange={value => { if (!busy) { setOpen(value); if (value) { setChoice("suggestion"); setError(null); } } }}>
    <PopoverTrigger asChild>
      <button type="button" aria-label="Review shipping address" title="Review shipping address" className="inline-flex h-7 w-7 items-center justify-center rounded hover:bg-amber-50" onClick={event => event.stopPropagation()}>
        <MapPin className={`h-4 w-4 ${resolved ? "text-green-600" : "text-amber-600"}`} />
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-[360px] max-w-[calc(100vw-24px)] p-3 space-y-3" onClick={event => event.stopPropagation()}>
      <div className="flex items-center justify-between"><h3 className="font-semibold">Shipping address</h3>{shipment.status === "draft" && linked ? <AddressEditDialog header="Edit shipping address" mode="delivery" shipment={shipment as ShipmentType} address={current as AddressType} onSubmit={saveAddress} trigger={<button type="button" aria-label="Edit shipping address" className="p-1 text-gray-500" disabled={busy}><Pencil className="h-4 w-4" /></button>} /> : <button type="button" className="text-xs underline" onClick={() => { setOpen(false); onEdit(); }}>View shipment</button>}</div>
      <label className={`flex gap-3 rounded-lg border p-3 ${choice === "current" ? "border-gray-800 bg-gray-50" : ""}`}>
        <input type="radio" name={`address-${shipment.id}`} checked={choice === "current"} onChange={() => setChoice("current")} disabled={busy} className="mt-1" />
        <div className="min-w-0 flex-1"><div className="font-semibold mb-2">Current</div>{address(current, false)}
          {!resolved && !saved && !state?.pending && <div className="mt-3 flex gap-2 rounded-md bg-amber-50 p-2 text-sm text-amber-900"><AlertTriangle className="h-4 w-4 shrink-0" />{addressIssue(current, suggestion)}</div>}
        </div>
      </label>
      {(saved || state?.pending) ? <p role="status" className="text-sm">Address saved. Validation is in progress.</p> : review.isFetching ? <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Checking suggestion…</p> : review.isError ? <div role="alert" className="text-sm">Address suggestions are unavailable. <button className="underline" onClick={() => review.refetch()}>Try again</button></div> : resolved ? <p className="text-sm" role="status">No outstanding address issues.</p> : suggestion ? <label className={`flex gap-3 rounded-lg border p-3 ${choice === "suggestion" ? "border-gray-800 bg-gray-50" : ""}`}>
        <input type="radio" name={`address-${shipment.id}`} checked={choice === "suggestion"} onChange={() => setChoice("suggestion")} disabled={busy} className="mt-1" />
        <div className="min-w-0 flex-1"><div className="font-semibold mb-2">Suggestion</div>{address({ ...current, ...suggestion }, true)}</div>
      </label> : <p className="text-sm">No verified suggestion is available. Edit the address to review it.</p>}
      {suggestion && !review.data?.can_use_suggestion && !resolved && <p className="text-sm text-muted-foreground">This suggestion needs manual review.</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setOpen(false)}>Close</Button>
        {actionable && <Button size="sm" disabled={!review.data?.can_use_suggestion || !suggestion || review.isFetching || busy || choice !== "suggestion"} onClick={accept}>{busy ? "Saving…" : "Use suggestion"}</Button>}
      </div>
    </PopoverContent>
  </Popover>;
}
