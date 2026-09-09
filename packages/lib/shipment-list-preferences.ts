import type { ShipmentListPreferences, ShipmentColumnId } from "@karrio/types";

export const SHIPMENT_COLUMNS: { id: ShipmentColumnId; label: string; defaultVisible: boolean }[] = [
  { id: "reference", label: "Order", defaultVisible: true },
  { id: "date", label: "Date", defaultVisible: true },
  { id: "recipient", label: "Customer", defaultVisible: true },
  { id: "status", label: "Status", defaultVisible: true },
  { id: "service", label: "Delivery method", defaultVisible: true },
  { id: "address", label: "Address check", defaultVisible: true },
  { id: "destination", label: "Destination", defaultVisible: true },
  { id: "ship-date", label: "Ship date", defaultVisible: true },
  { id: "delivery-date", label: "Delivery date", defaultVisible: false },
  { id: "rate", label: "Rate", defaultVisible: false },
  { id: "tracking", label: "Tracking number", defaultVisible: false },
  { id: "parcels", label: "Parcels", defaultVisible: false },
  { id: "erp-reference", label: "ERP reference", defaultVisible: false },
  { id: "updated", label: "Last updated", defaultVisible: false },
];

export const SHIPMENT_SORT_OPTIONS = [
  { value: "", label: "Recommended" },
  { value: "-created_at", label: "Date · newest first" },
  { value: "created_at", label: "Date · oldest first" },
  { value: "reference", label: "Order · A to Z" },
  { value: "-reference", label: "Order · Z to A" },
  { value: "recipient", label: "Customer · A to Z" },
  { value: "-recipient", label: "Customer · Z to A" },
  { value: "status", label: "Status · A to Z" },
  { value: "-status", label: "Status · Z to A" },
];

export const DEFAULT_SHIPMENT_LIST_PREFERENCES: ShipmentListPreferences = {
  columns: SHIPMENT_COLUMNS.map(({ id }) => id),
  hidden: SHIPMENT_COLUMNS.filter(({ defaultVisible }) => !defaultVisible).map(({ id }) => id),
  density: "compact",
  sort: "",
};

export function normalizeShipmentListPreferences(value: unknown): ShipmentListPreferences {
  const data = (value && typeof value === "object" ? value : {}) as Partial<ShipmentListPreferences>;
  const known = SHIPMENT_COLUMNS.map(({ id }) => id);
  const saved = Array.isArray(data.columns) ? data.columns.filter((id) => known.includes(id)) : [];
  return {
    columns: ["reference", ...Array.from(new Set([...saved, ...known])).filter((id) => id !== "reference")],
    hidden: Array.isArray(data.hidden)
      ? Array.from(new Set(data.hidden.filter((id) => known.includes(id) && id !== "reference")))
      : [...DEFAULT_SHIPMENT_LIST_PREFERENCES.hidden],
    density: data.density === "comfortable" ? "comfortable" : "compact",
    sort: SHIPMENT_SORT_OPTIONS.some(({ value }) => value === data.sort) ? data.sort! : "",
  };
}

export function moveShipmentColumn(columns: ShipmentColumnId[], from: ShipmentColumnId, to: ShipmentColumnId): ShipmentColumnId[] {
  if (from === "reference" || to === "reference" || from === to || !columns.includes(from) || !columns.includes(to)) return columns;
  const result = columns.filter((id) => id !== from);
  result.splice(columns.indexOf(to), 0, from);
  return result;
}
