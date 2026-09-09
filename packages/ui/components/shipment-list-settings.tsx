"use client";
import React from "react";
import { ArrowDown, ArrowUp, Columns3, Eye, EyeOff, GripVertical } from "lucide-react";
import type { ShipmentColumnId, ShipmentListPreferences } from "@karrio/types";
import { SHIPMENT_COLUMNS, SHIPMENT_SORT_OPTIONS, DEFAULT_SHIPMENT_LIST_PREFERENCES, moveShipmentColumn } from "@karrio/lib/shipment-list-preferences";
import { Popover, PopoverContent, PopoverTrigger } from "@karrio/ui/components/ui/popover";
import { Button } from "@karrio/ui/components/ui/button";

export function ShipmentListSettings({ preferences, onChange, sort, onSort }: {
  preferences: ShipmentListPreferences;
  onChange: (changes: Partial<ShipmentListPreferences>) => void;
  sort: string;
  onSort: (value: string) => void;
}) {
  const [dragging, setDragging] = React.useState<ShipmentColumnId | null>(null);
  const [announcement, setAnnouncement] = React.useState("");
  const move = (from: ShipmentColumnId, to: ShipmentColumnId) => {
    onChange({ columns: moveShipmentColumn(preferences.columns, from, to) });
    setAnnouncement(`${SHIPMENT_COLUMNS.find(({ id }) => id === from)?.label} column moved.`);
  };
  return <Popover>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-gray-600" aria-label="Customize columns and layout" title="Customize columns and layout"><Columns3 className="h-4 w-4" /></Button>
    </PopoverTrigger>
    <PopoverContent align="end" className="w-80 p-0 text-sm">
      <div className="space-y-3 border-b p-4">
        <h2 className="font-semibold">Customize list</h2>
        <label className="flex items-center justify-between gap-3">Sort by
          <select aria-label="Sort shipments" className="max-w-[180px] rounded border bg-background px-2 py-1 text-xs" value={sort} onChange={(event) => onSort(event.target.value)}>
            {SHIPMENT_SORT_OPTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="flex items-center justify-between gap-3">Row density
          <select aria-label="Row density" className="rounded border bg-background px-2 py-1 text-xs" value={preferences.density} onChange={(event) => onChange({ density: event.target.value as ShipmentListPreferences["density"] })}>
            <option value="compact">Compact</option><option value="comfortable">Comfortable</option>
          </select>
        </label>

      </div>
      <div className="px-4 pt-3 pb-1 text-xs text-muted-foreground">Columns · drag to reorder</div>
      <div className="max-h-[min(50vh,420px)] overflow-y-auto px-2 pb-2">
        {preferences.columns.filter((id) => id !== "reference").map((id, index, movable) => {
          const column = SHIPMENT_COLUMNS.find((column) => column.id === id)!;
          const visible = !preferences.hidden.includes(id);
          return <div key={id} className={`group flex items-center gap-2 rounded px-2 py-1 ${dragging === id ? "bg-muted opacity-60" : "hover:bg-muted/60"}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); if (dragging) move(dragging, id); setDragging(null); }}>
            <button type="button" draggable aria-label={`Drag ${column.label} column`} className="cursor-grab text-gray-400 active:cursor-grabbing"
              onDragStart={(event) => { setDragging(id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", id); }} onDragEnd={() => setDragging(null)}
              onKeyDown={(event) => { const target = event.key === "ArrowUp" ? movable[index - 1] : event.key === "ArrowDown" ? movable[index + 1] : null; if (target) { event.preventDefault(); move(id, target); } }}>
              <GripVertical className="h-4 w-4" />
            </button>
            <span className={`flex-1 ${visible ? "" : "text-muted-foreground"}`}>{column.label}</span>
            <button type="button" className="rounded p-1 text-gray-400 hover:bg-muted disabled:opacity-25" aria-label={`Move ${column.label} up`} disabled={index === 0} onClick={() => move(id, movable[index - 1])}><ArrowUp className="h-3 w-3" /></button>
            <button type="button" className="rounded p-1 text-gray-400 hover:bg-muted disabled:opacity-25" aria-label={`Move ${column.label} down`} disabled={index === movable.length - 1} onClick={() => move(id, movable[index + 1])}><ArrowDown className="h-3 w-3" /></button>
            <button type="button" className="rounded p-1 text-gray-600 hover:bg-muted" aria-label={`${visible ? "Hide" : "Show"} ${column.label}`} aria-pressed={visible} onClick={() => onChange({ hidden: visible ? [...preferences.hidden, id] : preferences.hidden.filter((hidden) => hidden !== id) })}>
              {visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4 text-gray-400" />}
            </button>
          </div>;
        })}
      </div>
      <div className="border-t p-3 flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">Saved in this browser</span>
        <Button variant="ghost" size="sm" className="text-xs" onClick={() => { onSort(""); onChange(DEFAULT_SHIPMENT_LIST_PREFERENCES); }}>Reset</Button>
      </div>
      <span role="status" className="sr-only">{announcement}</span>
    </PopoverContent>
  </Popover>;
}
