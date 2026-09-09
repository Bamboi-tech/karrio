import React from "react";
import type { ShipmentListPreferences } from "@karrio/types";
import { useKarrio, useQueryScope } from "./karrio";
import { useSyncedSession } from "./session";
import { DEFAULT_SHIPMENT_LIST_PREFERENCES, normalizeShipmentListPreferences } from "@karrio/lib/shipment-list-preferences";

export function useShipmentListPreferences() {
  const { pageData } = useKarrio();
  const { orgId, testMode } = useQueryScope();
  const { query: sessionQuery } = useSyncedSession();
  const userId = pageData?.user?.id || sessionQuery.data?.user?.email;
  const key = userId ? `karrio:shipment-list:v1:${userId}:${orgId || "personal"}:${testMode ? "test" : "live"}` : null;
  const [stored, setStored] = React.useState<{ key: string | null; value: ShipmentListPreferences }>({ key: null, value: DEFAULT_SHIPMENT_LIST_PREFERENCES });
  const [loadedKey, setLoadedKey] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!key) return;
    let value = DEFAULT_SHIPMENT_LIST_PREFERENCES;
    try { value = normalizeShipmentListPreferences(JSON.parse(window.localStorage.getItem(key) || "null")); } catch { /* Storage is optional. */ }
    setStored({ key, value });
    setLoadedKey(key);
  }, [key]);
  const preferences = stored.key === key ? stored.value : DEFAULT_SHIPMENT_LIST_PREFERENCES;
  const update = (changes: Partial<ShipmentListPreferences>) => {
    const value = normalizeShipmentListPreferences({ ...preferences, ...changes });
    setStored({ key, value });
    if (key) { try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep the current choice in memory. */ } }
  };
  return { preferences, update, ready: !!key && loadedKey === key };
}
