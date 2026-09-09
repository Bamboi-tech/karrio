import {
  ShipmentFilter,
  get_shipments,
  get_shipments_list,
  get_shipments_badge,
  get_shipment_follow,
  DISCARD_COMMODITY,
  PartialShipmentMutationInput,
  PARTIAL_UPDATE_SHIPMENT,
  get_shipment,
  partial_shipment_update,
  discard_commodity,
  discard_parcel,
  GET_SHIPMENTS,
  GET_SHIPMENTS_LIST,
  GET_SHIPMENTS_BADGE,
  GET_SHIPMENT_BADGE_COUNTS,
  GET_SHIPMENT,
  GET_SHIPMENT_FOLLOW,
  ChangeShipmentStatusMutationInput,
  CHANGE_SHIPMENT_STATUS,
  change_shipment_status,
  DISCARD_PARCEL,
} from "@karrio/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { gqlstr, handleFailure, insertUrlParam, onError } from "@karrio/lib";
import {
  scopeQueryKey,
  useAuthenticatedQuery,
  useKarrio,
  useQueryScope,
} from "./karrio";
import { ShipmentType } from "@karrio/types";
import { useSearchParams } from "next/navigation";
import React from "react";

const PAGE_SIZE = 20;
const PAGINATION = { offset: 0, first: PAGE_SIZE };

// Which shipment document the list fetches. "full" is the historical
// GET_SHIPMENTS (every address, customs, payment, all rates) and stays the
// default for the callers that edit shipments (manifests, pickups, labels).
// "list" is what the shipments board renders; "badge" is id + metadata for
// the card counters. See the queries for what each one selects.
export type ShipmentsVariant = "full" | "list" | "badge";
type ShipmentsData<V extends ShipmentsVariant> = V extends "list"
  ? get_shipments_list
  : V extends "badge"
    ? get_shipments_badge
    : get_shipments;
const SHIPMENTS_QUERY: Record<ShipmentsVariant, string> = {
  full: gqlstr(GET_SHIPMENTS),
  list: gqlstr(GET_SHIPMENTS_LIST),
  badge: gqlstr(GET_SHIPMENTS_BADGE),
};

type FilterType<V extends ShipmentsVariant> = ShipmentFilter & {
  setVariablesToURL?: boolean;
  cacheKey?: string;
  // A function form is evaluated against the CURRENT filter (which this
  // hook owns and seeds from the URL), for views that render something else
  // than the list — the Failed card — and want no page fetched behind it.
  isDisabled?: boolean | ((filter: ShipmentFilter) => boolean);
  preloadNextPage?: boolean;
  variant?: V;
};

// Normalizes filter input from any source — the hook's initialData, the URL
// (all strings) or a setFilter call — into the shape the query is keyed and
// sent with. Shared by the state initializer and setFilter so a deep link
// seeds exactly the filter a later setFilter would have produced.
function parseFilter(options: Record<string, unknown>): ShipmentFilter {
  return Object.keys(options).reduce((acc, key) => {
    if (["modal"].includes(key)) return acc;
    // A key explicitly set to undefined means "clear this filter". Dropping
    // it here keeps it out of the URL too — URLSearchParams would otherwise
    // stringify it to a literal "undefined", which then round-trips back in
    // as a real filter value. The string check heals URLs already polluted
    // that way.
    const value = options[key];
    if (value == null || value === "undefined") return acc;
    // Multi-value filters: a comma-joined URL param must round-trip back
    // into a list (fulfilment_mode is the Bamboi fork's route filter).
    if (["carrier_name", "status", "service", "fulfilment_mode"].includes(key))
      return {
        ...acc,
        [key]: ([] as unknown[])
          .concat(value as string | string[])
          .flatMap((item) =>
            typeof item === "string" ? item.split(",") : [item],
          )
          .map((v) => (v === "purchased" ? "created" : v)),
      };
    if (["offset", "first"].includes(key))
      return {
        ...acc,
        [key]: parseInt(value as string),
      };
    if (
      ["has_tracker", "has_manifest"].includes(key) ||
      ["true", "false"].includes(value as string)
    )
      return {
        ...acc,
        [key]: value === true || value === "true",
      };

    return {
      ...acc,
      [key]: value,
    };
  }, PAGINATION as ShipmentFilter);
}

export function useShipments<V extends ShipmentsVariant = "full">({
  setVariablesToURL = false,
  isDisabled = false,
  preloadNextPage = false,
  cacheKey,
  variant = "full" as V,
  ...initialData
}: FilterType<V> = {}) {
  const karrio = useKarrio();
  const queryClient = useQueryClient();
  const scope = useQueryScope();
  // Read through the router, not window.location: the dashboard pages are
  // rendered on the server too, and only the router knows the request's
  // search params on both sides — so a deep link seeds the same filter for
  // the server render and the hydrating client, and no second fetch is
  // needed to "apply" the URL after mount.
  const searchParams = useSearchParams();
  const [filter, _setFilter] = React.useState<ShipmentFilter>(() =>
    parseFilter({
      ...initialData,
      ...(setVariablesToURL && searchParams
        ? Object.fromEntries(searchParams.entries())
        : {}),
    }),
  );
  const fetch = (variables: { filter: ShipmentFilter }) => {
    // Underscore-prefixed statuses are UI sentinels (the Failed card's
    // "_failed_creation", the address-review card's "_address_review"): they
    // keep a FiltersCard highlighted but are not server-side statuses. Strip
    // them from the outgoing query; the rest of the filter still applies.
    const status = ([] as string[])
      .concat((variables.filter.status as any) || [])
      .filter((s) => !`${s}`.startsWith("_"));
    const warehouseView = ([] as string[]).concat(variables.filter.status || [])
      .map((status) => ({ _print_today: "today", _print_planned: "planned", _review_clear: "complete" } as Record<string, string>)[status])
      .find(Boolean);
    const filter = {
      ...variables.filter,
      ...(warehouseView ? { warehouse_view: warehouseView } : {}),
      ...(status.length ? { status } : { status: undefined }),
    } as ShipmentFilter;
    return karrio.graphql.request<ShipmentsData<V>>(SHIPMENTS_QUERY[variant], {
      variables: { filter },
    });
  };

  const disabled =
    typeof isDisabled === "function" ? isDisabled(filter) : isDisabled;

  // Queries
  const query = useAuthenticatedQuery({
    queryKey: [cacheKey || "shipments", filter],
    queryFn: () => fetch({ filter }),
    enabled: !disabled,
    keepPreviousData: true,
    staleTime: 5000,
    onError,
  });

  function setFilter(options: ShipmentFilter) {
    const params = parseFilter(options as Record<string, unknown>);

    if (setVariablesToURL) insertUrlParam(params);
    _setFilter(params);

    return params;
  }

  React.useEffect(() => {
    if (preloadNextPage === false || disabled) return;
    if (query.data?.shipments.page_info.has_next_page) {
      // The next page starts one page-size further, not a hardcoded 20 —
      // the shipments list lets the operator pick 20/50/100 via filter.first.
      const _filter = {
        ...filter,
        offset:
          ((filter.offset as number) || 0) +
          ((filter.first as number) || PAGE_SIZE),
      };
      // Same key shape (cache key + filter + org/test-mode scope) as the
      // query above builds through useAuthenticatedQuery, so the page the
      // operator clicks next actually hits this prefetch.
      queryClient.prefetchQuery(
        scopeQueryKey([cacheKey || "shipments", _filter], scope) as unknown[],
        () => fetch({ filter: _filter }),
      );
    }
  }, [query.data, filter.offset, queryClient]);

  return {
    query,
    filter,
    setFilter,
  };
}

// The fields the follow poll compares. A change in any of them is what the
// following page is waiting for (the ERP's pending flag clearing, the
// replaced_by link appearing, the status flipping to cancelled), and the one
// moment the full shipment is worth re-reading.
const followSnapshot = (
  shipment:
    | Pick<
        get_shipment_follow_shipment,
        "status" | "updated_at" | "tracker_id" | "metadata" | "meta"
      >
    | null
    | undefined,
) =>
  JSON.stringify(
    shipment
      ? [
          shipment.status,
          shipment.updated_at,
          shipment.tracker_id,
          shipment.metadata,
          shipment.meta,
        ]
      : null,
  );
type get_shipment_follow_shipment = NonNullable<
  get_shipment_follow["shipment"]
>;

export function useShipment(
  id: string,
  // refetchInterval: the shipment page polls while the ERP is validating a
  // corrected address, so it can follow to the draft the ERP rebuilds. The
  // poll itself reads only GET_SHIPMENT_FOLLOW (status + metadata + meta);
  // the full document is refetched once, when the poll sees a change.
  options: { refetchInterval?: number | false } = {},
) {
  const karrio = useKarrio();
  const queryClient = useQueryClient();
  const enabled = !!id && id !== "new";
  const followInterval = options.refetchInterval || false;

  // Queries
  const query = useAuthenticatedQuery({
    queryKey: ["shipments", id],
    queryFn: () =>
      karrio.graphql.request<get_shipment>(gqlstr(GET_SHIPMENT), {
        variables: { id },
      }),
    enabled,
    onError,
  });
  const latest = React.useRef<string>(followSnapshot(null));
  latest.current = followSnapshot(query.data?.shipment);

  // Its own key prefix on purpose: the mutation hooks invalidate
  // ["shipments"] and must not restart this poll on top of its own interval.
  useAuthenticatedQuery({
    queryKey: ["shipment-follow", id],
    queryFn: () =>
      karrio.graphql.request<get_shipment_follow>(gqlstr(GET_SHIPMENT_FOLLOW), {
        variables: { id },
      }),
    enabled: enabled && followInterval !== false,
    refetchInterval: followInterval,
    staleTime: 0,
    onSuccess: (data: get_shipment_follow) => {
      if (followSnapshot(data?.shipment) === latest.current) return;
      queryClient.invalidateQueries(["shipments", id]);
    },
  });

  return {
    query,
  };
}

export function useShipmentMutation(
  id?: string,
  // silent: the bulk runners on the shipments board fire one mutation per
  // row and refresh the list themselves, once, when the run is over —
  // fifty per-row invalidations of the heaviest query on the page would
  // otherwise restart the list fetch on every row.
  options: { silent?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const karrio = useKarrio();
  const invalidateCache = () => {
    if (options.silent) return;
    queryClient.invalidateQueries(["shipments"]);
    queryClient.invalidateQueries(["shipments", id]);
  };

  // Mutations
  // REST requests
  const fetchRates = useMutation(
    ({ id, ...data }: ShipmentType) =>
      handleFailure(
        id !== undefined && id !== "new"
          ? karrio.shipments
              .rates({ id, shipmentRateData: data as any })
              .then(({ data: { rates, messages } }) => ({ rates, messages }))
          : karrio.proxy
              .fetchRates({ rateRequest: data as any })
              .then(({ data: { rates, messages } }) => ({ rates, messages })),
      ),
    { onSuccess: invalidateCache, onError },
  );
  const buyLabel = useMutation(
    ({ id, selected_rate_id, ...shipment }: ShipmentType) =>
      handleFailure(
        id !== undefined && id !== "new"
          ? karrio.shipments
              .purchase({
                id,
                shipmentPurchaseData: { selected_rate_id } as any,
              })
              .then(({ data }) => data)
          : karrio.shipments
              .create({ shipmentData: shipment as any })
              .then(({ data }) => data),
      ),
    { onSuccess: invalidateCache, onError },
  );
  const voidLabel = useMutation(
    ({ id }: ShipmentType) =>
      handleFailure(karrio.shipments.cancel({ id }).then(({ data }) => data)),
    { onSuccess: invalidateCache, onError },
  );
  const createShipment = useMutation(
    (data: ShipmentType) =>
      handleFailure(
        karrio.shipments
          .create({ shipmentData: data as any })
          .then(({ data }) => data),
      ),
    { onSuccess: invalidateCache, onError },
  );
  const duplicateShipment = useMutation(
    async (source: ShipmentType) => {
      // Always duplicate from the full record: the shipments board hands
      // over its slim list row (no return/billing address, customs or
      // payment), and even the detail page's copy may be a few seconds old.
      const data =
        source.id && source.id !== "new"
          ? ((
              await karrio.graphql.request<get_shipment>(gqlstr(GET_SHIPMENT), {
                variables: { id: source.id },
              })
            ).shipment as ShipmentType | null) || source
          : source;
      const { shipment_date, shipping_date, ...options } = data.options || {};
      const shipmentData = {
        shipper: data.shipper,
        recipient: data.recipient,
        return_address: data.return_address,
        billing_address: data.billing_address,
        parcels: data.parcels.map(
          ({ id, reference_number, ...parcel }: any) => ({
            ...parcel,
            items: (parcel.items || []).map(({ id, ...item }: any) => item),
          }),
        ),
        ...(data.customs
          ? {
              customs: {
                ...data.customs,
                commodities: (data.customs.commodities || []).map(
                  ({ id, ...commodity }: any) => commodity,
                ),
              },
            }
          : {}),
        payment: data.payment,
        metadata: data.metadata,
        reference: data.reference,
        label_type: data.label_type,
        options,
      } as any;
      console.log("> shipment duplicate data", shipmentData);
      return handleFailure(
        karrio.shipments.create({ shipmentData }).then(({ data }) => data),
      );
    },
    { onSuccess: invalidateCache, onError },
  );

  // GraphQL requests
  const updateShipment = useMutation(
    (data: PartialShipmentMutationInput) =>
      karrio.graphql.request<partial_shipment_update>(
        gqlstr(PARTIAL_UPDATE_SHIPMENT),
        { data },
      ),
    { onSuccess: invalidateCache },
  );
  const discardCommodity = useMutation(
    (data: { id: string }) =>
      karrio.graphql.request<discard_commodity>(gqlstr(DISCARD_COMMODITY), {
        data,
      }),
    { onSuccess: invalidateCache, onError },
  );
  const discardParcel = useMutation(
    (data: { id: string }) =>
      karrio.graphql.request<discard_parcel>(gqlstr(DISCARD_PARCEL), { data }),
    { onSuccess: invalidateCache, onError },
  );
  const changeStatus = useMutation(
    (data: ChangeShipmentStatusMutationInput) =>
      karrio.graphql.request<change_shipment_status>(
        gqlstr(CHANGE_SHIPMENT_STATUS),
        { data },
      ),
    { onSuccess: invalidateCache },
  );

  return {
    buyLabel,
    voidLabel,
    fetchRates,
    changeStatus,
    createShipment,
    updateShipment,
    discardCommodity,
    duplicateShipment,
    discardParcel,
  };
}

export function useShipmentBadgeCounts() {
  const karrio = useKarrio();
  return useAuthenticatedQuery({
    queryKey: ["shipments", "badge-counts"],
    queryFn: () => karrio.graphql.request<Record<
      "today" | "hold" | "review",
      Pick<get_shipments_badge["shipments"], "page_info">
    >>(gqlstr(GET_SHIPMENT_BADGE_COUNTS)),
    staleTime: 5000,
    onError,
  });
}
