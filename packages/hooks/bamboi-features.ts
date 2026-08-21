"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { handleFailure } from "@karrio/lib";
import { useAuthenticatedQuery, useKarrio } from "./karrio";

// Bamboi fork: feature flags for the warehouse workstation. The ERP's flag
// registry is the single source of truth — the server relays GET/POST
// /v1/erp/features straight to it. This client-side table only exists so the
// dashboard keeps behaving sensibly when that relay is unavailable (network
// error, or 424 while ERP_GATE_URL/TOKEN is not configured yet): the defaults
// below are a verbatim copy of the ERP registry's defaults and MUST be kept
// in sync with it, never edited independently.
export const BAMBOI_FEATURE_DEFAULTS: Record<string, boolean> = {
  // Undo actions
  undo_pick: true,
  undo_shipped: true,
  undo_out_for_delivery: false,
  undo_delivered: false,
  undo_delivery_outcome: true,
  // Warehouse buttons
  btn_mark_picked: true,
  btn_mark_out_for_delivery: true,
  btn_mark_shipped: true,
  btn_cancel_shipment: true,
  btn_record_delivery_outcome: true,
  btn_buy_label_dashboard: true,
  btn_confirm_address: true,
  // Safety gates
  gate_shopify_hold_probe: true,
  gate_hold_block: true,
  gate_refund_block: true,
  gate_address_verdict: true,
  gate_status_transitions: true,
  gate_self_delivery_recheck: true,
};

export type BamboiFeatureGroup = "undo" | "button" | "gate";

export interface BamboiFeature {
  key: string;
  title: string;
  description: string;
  group: BamboiFeatureGroup;
  danger: boolean;
  default: boolean;
  enabled: boolean;
}

// Fallback rendering when the ERP relay is down: the registry only carries
// keys and defaults, so title/group are derived from the key. Good enough for
// a read-only (disabled) settings list; the real copy comes from the ERP.
const groupFromKey = (key: string): BamboiFeatureGroup =>
  key.startsWith("btn_") ? "button" : key.startsWith("gate_") ? "gate" : "undo";

const titleFromKey = (key: string): string => {
  const words = key
    .replace(/^(btn|gate)_/, "")
    .split("_")
    .join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const fallbackFeatures = (): BamboiFeature[] =>
  Object.entries(BAMBOI_FEATURE_DEFAULTS).map(([key, enabled]) => ({
    key,
    title: titleFromKey(key),
    description: "",
    group: groupFromKey(key),
    danger: false,
    default: enabled,
    enabled,
  }));

export function useBamboiFeatures() {
  const karrio = useKarrio();

  const query = useAuthenticatedQuery({
    queryKey: ["bamboi-features"],
    queryFn: () =>
      karrio.axios
        .get<{ features: BamboiFeature[] }>("/v1/erp/features")
        .then(({ data }) => data.features),
    // The registry barely changes; a short staleTime keeps every menu from
    // refetching it on mount while a settings toggle still shows up quickly.
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });

  // 424 is the server's "ERP relay not configured" answer — not an outage.
  // The settings page shows a banner for it; everything else silently runs
  // on the defaults below.
  const unconfigured = (query.error as any)?.response?.status === 424;

  // Server value wins; the local default covers loading, 424 and outright
  // failure. Because the defaults mirror the ERP registry, the pre-load
  // answer equals the post-load answer for untouched flags — no flicker.
  const isEnabled = (key: string): boolean => {
    const feature = (query.data || []).find((f) => f.key === key);
    return feature?.enabled ?? BAMBOI_FEATURE_DEFAULTS[key] ?? false;
  };

  return {
    features: query.data ?? fallbackFeatures(),
    isEnabled,
    loading: query.isLoading,
    error: query.error,
    unconfigured,
  };
}

export function useUpdateBamboiFeature() {
  const karrio = useKarrio();
  const queryClient = useQueryClient();

  return useMutation(
    ({ key, enabled }: { key: string; enabled: boolean }) =>
      handleFailure(
        karrio.axios
          .post<{ key: string; enabled: boolean }>("/v1/erp/features", {
            key,
            enabled,
          })
          .then(({ data }) => data),
      ),
    {
      // Refetch rather than optimistic write: the ERP may normalise or refuse
      // the change, and the list is small enough that a round-trip is cheap.
      onSuccess: () => queryClient.invalidateQueries(["bamboi-features"]),
    },
  );
}
