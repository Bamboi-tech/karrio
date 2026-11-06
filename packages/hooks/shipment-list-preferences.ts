import React from "react";
import type { ShipmentListPreferences } from "@karrio/types";
import { useKarrio, useQueryScope } from "./karrio";
import { useSyncedSession } from "./session";
import { DEFAULT_SHIPMENT_LIST_PREFERENCES, normalizeShipmentListPreferences } from "@karrio/lib/shipment-list-preferences";
import { shipmentListScope } from "@karrio/lib/shipment-list";

// Which stored preferences belong to this user, organization and mode; null
// until the session says who that is.
export function useShipmentListScope(): string | null {
  const { pageData } = useKarrio();
  const { orgId, testMode } = useQueryScope();
  const { query: sessionQuery } = useSyncedSession();
  const userId = pageData?.user?.email || sessionQuery.data?.user?.email;
  return userId ? shipmentListScope(userId, orgId, testMode) : null;
}

// `initial`: the preferences the server rendered with (its cookie mirror of
// this store), so the first client render matches the HTML. localStorage
// remains the source of truth and takes over once it is read.
export function useShipmentListPreferences(initial?: ShipmentListPreferences) {
  const { pageData } = useKarrio();
  const { orgId, testMode } = useQueryScope();
  const { query: sessionQuery } = useSyncedSession();
  const userId = pageData?.user?.email || sessionQuery.data?.user?.email;
  const key = userId ? `karrio:shipment-list:v1:${userId}:${orgId || "personal"}:${testMode ? "test" : "live"}` : null;
  const [stored, setStored] = React.useState<{ key: string | null; value: ShipmentListPreferences }>({ key: null, value: initial || DEFAULT_SHIPMENT_LIST_PREFERENCES });
  const [loadedKey, setLoadedKey] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!key) return;
    let value = DEFAULT_SHIPMENT_LIST_PREFERENCES;
    try { value = normalizeShipmentListPreferences(JSON.parse(window.localStorage.getItem(key) || "null")); } catch { /* Storage is optional. */ }
    setStored({ key, value });
    setLoadedKey(key);
  }, [key]);
  const preferences = stored.key === key || stored.key === null ? stored.value : DEFAULT_SHIPMENT_LIST_PREFERENCES;
  const update = (changes: Partial<ShipmentListPreferences>) => {
    const value = normalizeShipmentListPreferences({ ...preferences, ...changes });
    setStored({ key, value });
    if (key) { try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* Keep the current choice in memory. */ } }
  };
  return { preferences, update, ready: !!key && loadedKey === key };
}
