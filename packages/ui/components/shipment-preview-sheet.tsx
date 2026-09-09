"use client";
import dynamic from "next/dynamic";
import { useQueryClient } from "@tanstack/react-query";
import { useKarrio, useQueryScope, scopeQueryKey } from "@karrio/hooks/karrio";
import { GET_SHIPMENT, get_shipment } from "@karrio/types";
import { gqlstr } from "@karrio/lib";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetClose
} from "@karrio/ui/components/ui/sheet";
import { X } from "lucide-react";
import { useLocation } from "@karrio/hooks/location";
import React, { useState, useCallback, useMemo } from "react";
import { ShipmentPreviewSheetContext } from "@karrio/ui/components/shipment-preview-context";

export { ShipmentPreviewSheetContext } from "@karrio/ui/components/shipment-preview-context";

const loadShipment = () => import("@karrio/core/modules/Shipments/shipment").then((module) => module.ShipmentComponent);
const ShipmentComponent = dynamic(loadShipment, {
  loading: () => <div role="status" aria-label="Loading shipment" className="space-y-6 motion-safe:animate-pulse"><div className="h-6 w-36 rounded bg-gray-100" /><div className="h-28 rounded bg-gray-100" /><div className="h-20 rounded bg-gray-100" /></div>,
});

interface ShipmentPreviewSheetComponent {
  children?: React.ReactNode;
}

export const ShipmentPreviewSheet = ({ children }: ShipmentPreviewSheetComponent): JSX.Element => {
  const { addUrlParam, removeUrlParam } = useLocation();
  const queryClient = useQueryClient();
  const karrio = useKarrio();
  const scope = useQueryScope();
  const [isActive, setIsActive] = useState<boolean>(false);
  const [key, setKey] = useState<string>(`shipment-${Date.now()}`);
  const [shipmentId, setShipmentId] = useState<string>();

  const previewShipment = useCallback((shipmentId: string) => {
    setShipmentId(shipmentId);
    setIsActive(true);
    setKey(`shipment-${Date.now()}`);
    addUrlParam("modal", shipmentId);
  }, [addUrlParam]);

  const dismiss = (_?: any) => {
    setShipmentId(undefined);
    setIsActive(false);
    setKey(`shipment-${Date.now()}`);
    removeUrlParam("modal");
  };

  const prefetchShipment = useCallback((id: string) => {
    void loadShipment().catch(() => undefined);
    void queryClient.prefetchQuery({
      queryKey: scopeQueryKey(["shipments", id], scope) as unknown[],
      queryFn: () => karrio.graphql.request<get_shipment>(gqlstr(GET_SHIPMENT), { variables: { id } }),
      staleTime: 5000,
    });
  }, [queryClient, karrio, scope]);
  const value = useMemo(() => ({ previewShipment, prefetchShipment }), [previewShipment, prefetchShipment]);
  return (
    <>
      <ShipmentPreviewSheetContext.Provider value={value}>
        {children}
      </ShipmentPreviewSheetContext.Provider>

      <Sheet open={isActive} onOpenChange={(open) => !open && dismiss()}>
        <SheetContent
          className="w-full sm:w-[800px] sm:max-w-[800px] p-0 shadow-none"
          side="right"
        >
          <div className="h-full flex flex-col">
            <SheetHeader className="sticky top-0 z-10 bg-white px-4 py-3 border-b">
              <div className="flex items-center justify-between">
                <SheetTitle className="text-lg font-semibold">
                  Shipment Preview
                </SheetTitle>
                <SheetClose className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close</span>
                </SheetClose>
              </div>
              <SheetDescription className="sr-only">Shipment details and activity</SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-4 py-4">
              {isActive && shipmentId && (
                <ShipmentComponent
                  key={key}
                  shipmentId={shipmentId}
                  isPreview={true}
                  isSheet={true}
                />
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
};