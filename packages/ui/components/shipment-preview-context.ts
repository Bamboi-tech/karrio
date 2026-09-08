"use client";

import React from "react";

// Lets anything rendered inside the shipment preview sheet swap the sheet to
// another shipment. Kept apart from the sheet component on purpose: the sheet
// renders the shipment page, and the shipment page uses this context to open
// the draft that replaced the one it shows — a cycle if both lived in one file.
export type ShipmentPreviewSheetContextType = {
  previewShipment: (shipmentId: string) => void;
};

export const ShipmentPreviewSheetContext =
  React.createContext<ShipmentPreviewSheetContextType>(
    {} as ShipmentPreviewSheetContextType,
  );
