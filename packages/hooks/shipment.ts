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
  GraphQLApi,
  ServerSeed,
  ShipmentsPageSeed,
  shipment_badge_counts,
} from "@karrio/types";
import {
  hashQueryKey,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  gqlstr,
  handleFailure,
  insertUrlParam,
  onError,
  onIdle,
} from "@karrio/lib";
import {
  SHIPMENT_PAGE_SIZE,
  initialShipmentFilter,
  isFailedShipmentsView,
  parseShipmentFilter,
  readShipmentListCookie,
  shipmentListFilter,
  shipmentQueryFilter,
} from "@karrio/lib/shipment-list";
import {
  QueryScope,
  scopeQueryKey,
  useAuthenticatedQuery,
  useKarrio,
  useQueryScope,
} from "./karrio";
import { useShipmentListScope } from "./shipment-list-preferences";
import { ShipmentType } from "@karrio/types";
import { useSearchParams } from "next/navigation";
import React from "react";

const PAGE_SIZE = SHIPMENT_PAGE_SIZE;
const STALE_TIME = 5000;
// How long the next page's preload waits for an idle browser.
const NEXT_PAGE_IDLE_MS = 1000;

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
  // The first page as the server page fetched it ("list" variant only).
  initial?:
    | (ServerSeed<get_shipments_list> &
        Pick<ShipmentsPageSeed, "filter" | "scope">)
    | null;
};

// A result the server page fetched, with the filter and cache scope it was
// fetched for; it seeds only the query with exactly that key.
type Seeded<T> = (ServerSeed<T> & Pick<ShipmentsPageSeed, "scope">) | null;
const sameScope = (a: QueryScope, b: QueryScope) =>
  (a.orgId || null) === (b.orgId || null) && !!a.testMode === !!b.testMode;

// The one definition of a shipments page query. useShipments, its
// prefetches and the prefetch other pages do for the board all build their
// key and fetch here, so a prefetched page is the page the board reads.
export function shipmentsQuery<V extends ShipmentsVariant>(
  karrio: { graphql: GraphQLApi },
  filter: ShipmentFilter,
  variant: V,
  cacheKey?: string,
) {
  return {
    queryKey: [cacheKey || "shipments", filter] as unknown[],
    queryFn: () =>
      karrio.graphql.request<ShipmentsData<V>>(SHIPMENTS_QUERY[variant], {
        variables: { filter: shipmentQueryFilter(filter) },
      }),
  };
}

export function useShipments<V extends ShipmentsVariant = "full">({
  setVariablesToURL = false,
  isDisabled = false,
  preloadNextPage = false,
  cacheKey,
  variant = "full" as V,
  initial,
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
    initialShipmentFilter(
      initialData,
      setVariablesToURL && searchParams
        ? Object.fromEntries(searchParams.entries())
        : null,
    ),
  );
  const queryOf = (filter: ShipmentFilter) =>
    shipmentsQuery(karrio, filter, variant, cacheKey);

  const disabled =
    typeof isDisabled === "function" ? isDisabled(filter) : isDisabled;

  // Queries
  // The seed lands on the key it was fetched for and no other: a filter
  // change makes a new key and fetches. Its fetch time travels along, so a
  // page that sat unhydrated past the stale time refetches on mount.
  const seeded =
    !!initial &&
    sameScope(initial.scope, scope) &&
    hashQueryKey([initial.filter]) === hashQueryKey([filter]);
  const query = useAuthenticatedQuery({
    ...queryOf(filter),
    initialData: seeded ? (initial.data as ShipmentsData<V>) : undefined,
    initialDataUpdatedAt: seeded ? initial.fetchedAt : undefined,
    enabled: !disabled,
    keepPreviousData: true,
    staleTime: STALE_TIME,
    onError,
  });

  function prefetch(options: ShipmentFilter) {
    const nextFilter = parseShipmentFilter(options as Record<string, unknown>);
    if (isFailedShipmentsView(nextFilter)) return;
    const { queryKey, queryFn } = queryOf(nextFilter);
    return queryClient.prefetchQuery({
      queryKey: scopeQueryKey(queryKey, scope) as unknown[],
      queryFn,
      staleTime: STALE_TIME,
    });
  }

  function setFilter(options: ShipmentFilter) {
    const params = parseShipmentFilter(options as Record<string, unknown>);

    if (setVariablesToURL) insertUrlParam(params);
    _setFilter(params);

    return params;
  }

  React.useEffect(() => {
    if (preloadNextPage === false || disabled) return;
    // Never ahead of the page it follows: rows kept on screen while another
    // filter loads say nothing about that filter's next page.
    if (query.isPreviousData) return;
    if (!query.data?.shipments.page_info.has_next_page) return;
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
    // operator clicks next actually hits this prefetch. Sent once the
    // browser is idle: a first page that came with the HTML is on screen
    // before hydration, and its successor must not join the requests
    // hydration starts.
    const { queryKey, queryFn } = queryOf(_filter);
    return onIdle(() => {
      queryClient.prefetchQuery(
        scopeQueryKey(queryKey, scope) as unknown[],
        queryFn,
      );
    }, NEXT_PAGE_IDLE_MS);
  }, [query.data, query.isPreviousData, filter.offset, queryClient]);

  return {
    query,
    filter,
    setFilter,
    prefetch,
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

// The counts on the board's status cards: key and fetch, like shipmentsQuery.
export function shipmentBadgeCountsQuery(karrio: { graphql: GraphQLApi }) {
  return {
    queryKey: ["shipments", "badge-counts"] as unknown[],
    queryFn: () =>
      karrio.graphql.request<shipment_badge_counts>(
        gqlstr(GET_SHIPMENT_BADGE_COUNTS),
      ),
  };
}

export function useShipmentBadgeCounts(
  initial?: Seeded<shipment_badge_counts>,
) {
  const karrio = useKarrio();
  const scope = useQueryScope();
  const seeded = !!initial && sameScope(initial.scope, scope);
  return useAuthenticatedQuery({
    ...shipmentBadgeCountsQuery(karrio),
    initialData: seeded ? initial.data : undefined,
    initialDataUpdatedAt: seeded ? initial.fetchedAt : undefined,
    staleTime: STALE_TIME,
    onError,
  });
}

// Warms the board's default first page and its card counts from somewhere
// else — the home page when it is idle, the sidebar link on hover or focus
// — with the keys and fetches the board itself uses. The view comes from
// the same cookie the board's server page reads, so both arrive at one
// filter.
export function usePrefetchShipmentsList() {
  const karrio = useKarrio();
  const queryClient = useQueryClient();
  const scope = useQueryScope();
  const viewScope = useShipmentListScope();

  return React.useCallback(() => {
    if (!karrio.isAuthenticated || !viewScope) return;
    const filter = shipmentListFilter(null, readShipmentListCookie(viewScope));
    const prefetch = <T,>(query: { queryKey: unknown[]; queryFn: () => Promise<T> }) =>
      queryClient.prefetchQuery({
        queryKey: scopeQueryKey(query.queryKey, scope) as unknown[],
        queryFn: query.queryFn,
        staleTime: STALE_TIME,
      });
    return Promise.all([
      prefetch(shipmentsQuery(karrio, filter, "list")),
      prefetch(shipmentBadgeCountsQuery(karrio)),
    ]);
  }, [karrio, queryClient, scope, viewScope]);
}
