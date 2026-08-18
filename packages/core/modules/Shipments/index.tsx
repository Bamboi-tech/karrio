"use client";
import {
  formatAddressShort,
  formatAddressLocationShort,
  formatDate,
  formatDateTime,
  formatRef,
  getURLSearchParams,
  isNone,
  isNoneOrEmpty,
  formatCarrierSlug,
  preventPropagation,
} from "@karrio/lib";
import {
  ShipmentPreviewSheet,
  ShipmentPreviewSheetContext,
} from "@karrio/ui/components/shipment-preview-sheet";
import { FailedShipmentSheet } from "@karrio/ui/components/failed-shipment-sheet";
import { FailedShipmentsList } from "@karrio/core/modules/Shipments/failed-shipments-list";
import { useSystemConnections } from "@karrio/hooks/system-connection";
import { useDocumentTemplates } from "@karrio/hooks/document-template";
import { useCarrierConnections } from "@karrio/hooks/user-connection";
import { useDocumentPrinter, FormatType } from "@karrio/hooks/resource-token";
import { ShipmentsFilter } from "@karrio/ui/components/shipments-filter";
import { AddressType, RateType, ShipmentType } from "@karrio/types";
import { ShipmentMenu } from "@karrio/ui/components/shipment-menu";
import { FiltersCard } from "@karrio/ui/components/filters-card";
import { ListPagination } from "@karrio/ui/components/list-pagination";
import { StickyTableWrapper } from "@karrio/ui/components/sticky-table-wrapper";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell
} from "@karrio/ui/components/ui/table";
import { Button } from "@karrio/ui/components/ui/button";
import { Checkbox } from "@karrio/ui/components/ui/checkbox";
import { Skeleton } from "@karrio/ui/components/ui/skeleton";
import { Loader2 } from "lucide-react";
import { CarrierImage } from "@karrio/ui/core/components/carrier-image";
import { ShipmentsStatusBadge } from "@karrio/ui/components/shipments-status-badge";
import {
  AddressValidationBadge,
  getAddressReview,
  ADDRESS_REVIEW_FLAG,
} from "@karrio/ui/components/address-validation-badge";
import {
  getShopifyHold,
  SHOPIFY_HOLD_KEY,
} from "@karrio/ui/components/shipment-hold";
import { useAPIMetadata } from "@karrio/hooks/api-metadata";
import { useLoader } from "@karrio/ui/core/components/loader";
import { AppLink } from "@karrio/ui/core/components/app-link";
import { useShipments } from "@karrio/hooks/shipment";
import React, { useContext, useEffect } from "react";
import { useSearchParams } from "next/navigation";

const FAILED_SENTINEL = "_failed_creation";
// Keeps the Needs Attention card highlighted while the real filtering happens
// via metadata_key (see onFilterChange); stripped from the outgoing query by
// useShipments like every "_"-prefixed sentinel.
const ADDRESS_REVIEW_SENTINEL = "_address_review";
// The warehouse print-worklist views. All three query status=draft server-side
// (the sentinel is stripped by useShipments) and are narrowed client-side —
// the API's metadata_key filter can only test key presence, so it can neither
// EXCLUDE the address-review flag (Complete) nor compare a metadata date
// against today (Planned/Today). See visibleShipments below.
const COMPLETE_SENTINEL = "_review_clear";
const PLANNED_SENTINEL = "_print_planned";
const TODAY_SENTINEL = "_print_today";
// The On hold card is the exception among the draft views: hold is a plain
// metadata-key presence, which the API's metadata_key filter CAN test — so
// this card filters server-side (like Needs Attention) and its pagination
// count is exact. The sentinel only keeps the card highlighted.
const HOLD_SENTINEL = "_on_hold";

// Planning metadata mirrored onto every draft by the ERP (karrio_shipping):
// the day the parcel leaves (shipment_date), where that day came from
// (shipment_date_source: "monta" = Monta's planned day, anything else is a
// fallback derived from the delivery date) and the day the warehouse must
// print/prep (print_date).
const SHIP_DATE_KEY = "shipment_date";
const SHIP_DATE_SOURCE_KEY = "shipment_date_source";
const PRINT_DATE_KEY = "print_date";
// The day the customer expects the parcel (ISO date), mirrored by the ERP.
const DELIVERY_DATE_KEY = "delivery_date";

// The warehouse plans in Amsterdam wall-clock days; the browser (or a
// traveling laptop) must not shift the worklist by comparing in local time.
const amsterdamToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(
    new Date(),
  );

// Metadata values are untrusted JSON: accept "YYYY-MM-DD" with or without a
// time suffix, reject everything else. ISO date strings compare correctly as
// plain strings.
const asISODate = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
};

// Client-side mirror of the Needs Attention card's server filter
// (metadata_key=address_review_required tests key presence).
const hasAddressReviewFlag = (metadata: unknown) =>
  ADDRESS_REVIEW_FLAG in ((metadata || {}) as Record<string, unknown>);

const getPrintDate = (metadata: unknown) =>
  asISODate(((metadata || {}) as Record<string, unknown>)[PRINT_DATE_KEY]);

// Amsterdam calendar days between two ISO dates. Both parse as UTC midnight,
// so the difference is an exact whole number of days.
const daysBetween = (fromISODate: string, toISODate: string) =>
  Math.round((Date.parse(toISODate) - Date.parse(fromISODate)) / 86400000);

export default function Page(pageProps: any) {
  const Component = (): JSX.Element => {
    const searchParams = useSearchParams();
    const { setLoading } = useLoader();
    const { references } = useAPIMetadata();
    const [allChecked, setAllChecked] = React.useState(false);
    const [initialized, setInitialized] = React.useState(false);
    const [selection, setSelection] = React.useState<string[]>([]);
    const { previewShipment } = useContext(ShipmentPreviewSheetContext);
    const { user_connections } = useCarrierConnections();
    const { system_connections } = useSystemConnections();
    const documentPrinter = useDocumentPrinter();
    const context = useShipments({
      status: [
        "created",
        "shipped",
        "delivered",
        "in_transit",
        "cancelled",
        "needs_attention",
        "out_for_delivery",
        "delivery_failed",
      ] as any,
      setVariablesToURL: true,
      preloadNextPage: true,
    });
    const {
      query: { data: { shipments } = {}, ...query },
      filter,
      setFilter,
    } = context;
    // Count-badge queries, independent of whichever card is active.
    // - On hold: metadata_key presence is server-filterable, so one row
    //   (first: 1) is enough — page_info.count is the exact total.
    // - Today: not expressible server-side (date comparison + key
    //   exclusions), so it is counted over the FIRST draft page only and
    //   rendered as "N+" when more draft pages exist. Cheap (one extra
    //   request, shared react-query cache) and honest about its limit;
    //   daily volumes make a multi-page Today unusual.
    // Both use their own cacheKey, so mutations that invalidate the
    // ["shipments"] key do not refresh them — staleTime keeps them at most
    // a few seconds behind, which is fine for an advisory badge.
    const draftBadge = useShipments({
      status: ["draft"] as any,
      cacheKey: "shipments-badge-draft",
    });
    const holdBadge = useShipments({
      status: ["draft"] as any,
      metadata_key: SHOPIFY_HOLD_KEY,
      first: 1,
      cacheKey: "shipments-badge-hold",
    });
    const {
      query: { data: { document_templates } = {} },
    } = useDocumentTemplates({
      related_object: "shipment" as any,
      active: true,
    });

    const updateFilter = (extra: Partial<any> = {}) => {
      const query = {
        ...filter,
        ...getURLSearchParams(),
        ...extra,
      };

      setFilter(query);
    };
    const updatedSelection = (
      selectedShipments: string[],
      current: { node: Pick<ShipmentType, "id"> }[],
    ) => {
      const shipment_ids = current.map(({ node: shipment }) => shipment.id);
      const selection = selectedShipments.filter((id) =>
        shipment_ids.includes(id),
      );
      const selected =
        selection.length > 0 &&
        selection.length === (shipment_ids || []).length;
      setAllChecked(selected);
      if (
        selectedShipments.filter((id) => !shipment_ids.includes(id)).length > 0
      ) {
        setSelection(selection);
      }
    };
    const handleCheckboxChange = (checked: boolean, name: string) => {
      if (name === "all") {
        setSelection(
          !checked ? [] : visibleShipments.map(({ node: { id } }) => id),
        );
      } else {
        setSelection(
          checked
            ? [...selection, name]
            : selection.filter((id) => id !== name),
        );
      }
    };
    const computeDocFormat = (selection: string[]) => {
      const _shipment = (shipments?.edges || []).find(
        ({ node: shipment }) => shipment.id == selection[0],
      );
      return (_shipment?.node || {}).label_type;
    };
    const compatibleTypeSelection = (selection: string[]) => {
      const format = computeDocFormat(selection);
      return (
        (shipments?.edges || []).filter(
          ({ node: shipment }) =>
            selection.includes(shipment.id) && shipment.label_type == format,
        ).length === selection.length
      );
    };
    const draftSelection = (selection: string[]) => {
      return (
        (shipments?.edges || []).filter(
          ({ node: shipment }) =>
            selection.includes(shipment.id) && shipment.status == "draft",
        ).length === selection.length
      );
    };
    const getRate = (shipment: any) =>
      shipment.selected_rate ||
      (shipment?.rates || []).find(
        (_: RateType) => _.service === shipment?.options?.preferred_service,
      ) ||
      (shipment?.rates || [])[0] ||
      shipment;
    const getCarrier = (rate?: ShipmentType["rates"][0]) =>
      (user_connections || []).find(
        (_) =>
          _.id === (rate?.meta as any)?.carrier_connection_id ||
          _.carrier_id === rate?.carrier_id,
      ) ||
      (system_connections || []).find(
        (_) =>
          _.id === (rate?.meta as any)?.carrier_connection_id ||
          _.carrier_id === rate?.carrier_id,
      );
    // Address drafts held for correction carry the ERP's Google verdict in
    // their metadata. Rendered as its own column so the operator sees the whole
    // "needs a corrected address" worklist in one pass over the Draft view.
    const renderAddressReview = (metadata: unknown, meta: unknown) => {
      const review = getAddressReview(metadata, meta);
      if (!review) return <span className="text-gray-300">-</span>;
      return (
        <div style={{ lineHeight: "16px", maxWidth: "220px" }}>
          <AddressValidationBadge
            status={review.status}
            title={review.note || ""}
          />
          {review.pending && (
            <p className="text-gray-500 font-medium mt-1">
              re-checking with Google
            </p>
          )}
          {review.suggestion && (
            <p
              className="text-gray-500 font-medium text-ellipsis mt-1"
              title={review.suggestion}
            >
              Google: {review.suggestion}
            </p>
          )}
        </div>
      );
    };

    // The day the parcel is planned to leave, mirrored by the ERP. A value
    // whose source isn't "monta" is only derived from the delivery date, so it
    // is rendered muted with a "~" prefix until Monta's planned day arrives.
    const renderShipDate = (metadata: unknown) => {
      const values = (metadata || {}) as Record<string, unknown>;
      const shipDate = asISODate(values[SHIP_DATE_KEY]);
      if (!shipDate) return <span className="text-gray-300">—</span>;
      const fromMonta = values[SHIP_DATE_SOURCE_KEY] === "monta";
      if (fromMonta) {
        return (
          <p className="text-xs font-semibold text-gray-700">
            {formatDate(shipDate)}
          </p>
        );
      }
      return (
        <p
          className="text-xs font-medium text-gray-400"
          title="afgeleid van leverdatum; Monta's geplande dag nog niet binnen"
        >
          ~{formatDate(shipDate)}
        </p>
      );
    };

    // The customer-facing delivery day. Sits next to SHIP DATE so that on a
    // Friday a label "for Monday" reads in one glance: leaves Friday,
    // delivers Monday. Date-only; rows the ERP has not stamped show "—".
    const renderDeliveryDate = (metadata: unknown) => {
      const deliveryDate = asISODate(
        ((metadata || {}) as Record<string, unknown>)[DELIVERY_DATE_KEY],
      );
      if (!deliveryDate) return <span className="text-gray-300">—</span>;
      return (
        <p className="text-xs font-semibold text-gray-700">
          {formatDate(deliveryDate)}
        </p>
      );
    };

    // Today-only: how long a row has been waiting. print_date < today (in
    // Amsterdam wall-clock days) → red "N d te laat"; == today → neutral, no
    // marker; missing → "—" so the fail-visible dateless rows stay
    // recognizable as "unknown", not "on time".
    const renderPrintOverdue = (metadata: unknown) => {
      const printDate = getPrintDate(metadata);
      if (!printDate)
        return <p className="text-xs font-medium text-gray-400">—</p>;
      const today = amsterdamToday();
      if (printDate >= today) return null;
      const daysLate = daysBetween(printDate, today);
      return (
        <span className="inline-block rounded bg-red-100 text-red-700 text-xs font-semibold px-1.5 py-0.5 mt-1">
          {daysLate} d te laat
        </span>
      );
    };

    // Client-side Today count over the first draft page (see the badge-query
    // comment above): same predicate as the Today view, "+" suffix when more
    // draft pages exist and the count is therefore a lower bound.
    const todayBadge = React.useMemo(() => {
      const page = draftBadge.query.data?.shipments;
      if (!page) return undefined;
      const today = amsterdamToday();
      const count = (page.edges || []).filter(({ node: shipment }) => {
        if (hasAddressReviewFlag(shipment.metadata)) return false;
        if (getShopifyHold(shipment.metadata).held) return false;
        const printDate = getPrintDate(shipment.metadata);
        return !printDate || printDate <= today;
      }).length;
      return `${count}${page.page_info?.has_next_page ? "+" : ""}`;
    }, [draftBadge.query.data]);
    // Exact: the server counted every draft carrying the hold key.
    const holdCount = holdBadge.query.data?.shipments?.page_info?.count;
    const holdBadgeLabel = holdCount == null ? undefined : `${holdCount}`;

    // The cards follow the shipment lifecycle left-to-right: fix addresses
    // (Needs Attention) → clean drafts (Complete) → parked drafts (On hold) →
    // print later (Planned) → print now (Today) → labeled, waiting for the
    // carrier (Picked) → on the road (Shipped) → Delivered, with the failure
    // buckets at the end.
    const getFilterOptions = () => [
      {
        label: "All",
        value: [
          "created",
          "shipped",
          "delivered",
          "in_transit",
          "cancelled",
          "needs_attention",
          "out_for_delivery",
          "delivery_failed",
        ],
      },
      {
        // The address worklist: every shipment whose delivery address is
        // flagged Suspect/Invalid and waits on a human decision. Keyed on the
        // metadata flag the ERP stamps, not on a Karrio status — flagged
        // drafts are status "draft", which no status filter can isolate.
        label: "Needs Attention",
        value: [ADDRESS_REVIEW_SENTINEL],
      },
      {
        // Every draft whose address review is done or was never needed —
        // status "draft" minus the Needs Attention worklist. (Renames the old
        // Draft card; the backend status is still "draft".)
        label: "Complete",
        value: ["draft", COMPLETE_SENTINEL],
      },
      {
        // Drafts whose Shopify order is on hold (metadata.shopify_hold,
        // stamped by the ERP): parked, not forgotten. They are excluded from
        // Complete/Planned/Today — even with an elapsed print_date — and live
        // here until the hold is released. Filtered server-side on key
        // presence (see onFilterChange), like Needs Attention.
        label: "On hold",
        value: ["draft", HOLD_SENTINEL],
        badge: holdBadgeLabel,
      },
      {
        // Clean drafts whose print day is still ahead.
        label: "Planned",
        value: ["draft", PLANNED_SENTINEL],
      },
      {
        // Rico's printlist: clean drafts due today — including overdue
        // print dates (forgotten work must stay visible) and drafts without a
        // print_date (fail-visible: better one row too many here than one
        // silently missing). A shipment fresh off a Shopify hold (key already
        // removed, ERP recalculation not yet run) lands here through the
        // elapsed-print_date branch — visibility must not wait for the
        // recalculation.
        label: "Today",
        value: ["draft", TODAY_SENTINEL],
        badge: todayBadge,
      },
      {
        // Labeled but not yet handed to the carrier ("purchased" is aliased
        // to "created" by useShipments).
        label: "Picked",
        value: ["created"],
      },
      {
        label: "Shipped",
        value: ["shipped", "in_transit", "out_for_delivery"],
      },
      {
        label: "Delivered",
        value: ["delivered"],
      },
      {
        label: "Exception",
        value: ["needs_attention", "delivery_failed"],
      },
      {
        label: "Cancelled",
        value: ["cancelled"],
      },
      {
        label: "Failed",
        value: [FAILED_SENTINEL],
      },
    ];

    const statusFilter = ([] as string[]).concat((filter?.status as any) || []);
    const isFailedView = statusFilter.includes(FAILED_SENTINEL);
    const isCompleteView = statusFilter.includes(COMPLETE_SENTINEL);
    const isPlannedView = statusFilter.includes(PLANNED_SENTINEL);
    const isTodayView = statusFilter.includes(TODAY_SENTINEL);
    const isHoldView = statusFilter.includes(HOLD_SENTINEL);

    // Complete/Planned/Today are narrowed client-side over the fetched
    // status=draft page (see the sentinel comment up top for why the API
    // cannot do this). Limitation: the narrowing happens per 20-row page, so
    // the pagination count/next-page still describe the full draft list and a
    // page can render fewer rows than it says. Daily volumes are small enough
    // that this is acceptable.
    const visibleShipments = React.useMemo(() => {
      const edges = shipments?.edges || [];
      if (isHoldView) {
        // The server already narrowed to metadata_key=shopify_hold; this
        // mirror only guards against a hold released between refetches.
        return edges.filter(
          ({ node: shipment }) => getShopifyHold(shipment.metadata).held,
        );
      }
      if (!isCompleteView && !isPlannedView && !isTodayView) return edges;
      const today = amsterdamToday();
      const narrowed = edges.filter(({ node: shipment }) => {
        if (hasAddressReviewFlag(shipment.metadata)) return false;
        // Held orders are parked on the On hold card — never in the print
        // worklist, elapsed print_date or not.
        if (getShopifyHold(shipment.metadata).held) return false;
        if (isCompleteView) return true;
        const printDate = getPrintDate(shipment.metadata);
        if (isPlannedView) return !!printDate && printDate > today;
        // Today: due or overdue print dates, plus drafts the ERP has not
        // stamped a print_date on yet — never silently hidden.
        return !printDate || printDate <= today;
      });
      if (!isTodayView) return narrowed;
      // Today is a work queue: longest-waiting (oldest print_date) first.
      // Dateless drafts sort to the TOP — "unknown" is an attention case
      // that must not drown below a page of dated rows.
      return [...narrowed].sort(({ node: a }, { node: b }) => {
        const printA = getPrintDate(a.metadata);
        const printB = getPrintDate(b.metadata);
        if (!printA && !printB) return 0;
        if (!printA) return -1;
        if (!printB) return 1;
        return printA < printB ? -1 : printA > printB ? 1 : 0;
      });
    }, [shipments, isCompleteView, isPlannedView, isTodayView, isHoldView]);

    const searchParamsString = searchParams?.toString() ?? "";
    useEffect(() => {
      updateFilter();
    }, [searchParamsString]);
    useEffect(() => {
      if (!isFailedView) setLoading(query.isFetching);
    }, [query.isFetching, isFailedView]);
    useEffect(() => {
      updatedSelection(selection, visibleShipments);
    }, [selection, visibleShipments]);
    useEffect(() => {
      if (
        query.isFetched &&
        !initialized &&
        !isNoneOrEmpty(searchParams.get("modal"))
      ) {
        previewShipment(searchParams.get("modal") as string);
        setInitialized(true);
      }
    }, [searchParams.get("modal"), query.isFetched]);

    return (
      <>
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between px-0 pb-0 pt-4 mb-2">
          <div className="mb-4 sm:mb-0">
            <h1 className="text-2xl font-semibold text-gray-900">Shipments</h1>
          </div>
          <div className="flex flex-row items-center gap-1 flex-wrap">
            <Button asChild size="sm" className="mx-1 w-auto">
              <AppLink href="/create_label?shipment_id=new">
                Create Label
              </AppLink>
            </Button>
            <Button asChild size="sm" className="mx-1 w-auto">
              <AppLink href="/manifests/create_manifests">
                Manage manifests
              </AppLink>
            </Button>
            {!isFailedView && <ShipmentsFilter context={context} />}
          </div>
        </header>

        <FiltersCard
          filters={getFilterOptions()}
          activeFilter={filter?.status || []}
          onFilterChange={(status) =>
            updateFilter({
              status,
              // Needs Attention and On hold both filter on an ERP-stamped
              // metadata key server-side; every other card must clear it or
              // its status filter would intersect with those worklists.
              metadata_key: (status as string[]).includes(
                ADDRESS_REVIEW_SENTINEL,
              )
                ? ADDRESS_REVIEW_FLAG
                : (status as string[]).includes(HOLD_SENTINEL)
                  ? SHOPIFY_HOLD_KEY
                  : undefined,
              offset: 0,
            })
          }
        />

        {isFailedView && <FailedShipmentsList />}

        {!isFailedView && !query.isFetched && (
          <div className="bg-white rounded-lg shadow-sm border my-6 p-6">
            <div className="space-y-4">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-center space-x-4">
                  <Skeleton className="h-4 w-4" />
                  <Skeleton className="h-4 w-[100px]" />
                  <Skeleton className="h-4 w-[80px]" />
                  <Skeleton className="h-4 w-[120px]" />
                  <Skeleton className="h-4 w-[100px]" />
                  <Skeleton className="h-4 w-[80px]" />
                  <Skeleton className="h-4 w-6" />
                </div>
              ))}
            </div>
          </div>
        )}

        {!isFailedView && query.isFetched && visibleShipments.length > 0 && (
          <>
            <StickyTableWrapper>
              <Table className="shipments-table">
              <TableHeader>
                <TableRow>
                  <TableHead
                    className="selector text-center p-0 items-center sticky-left"
                    onClick={preventPropagation}
                  >
                    <div className="py-2 pl-2 pr-4">
                      <Checkbox
                        checked={allChecked}
                        onCheckedChange={(checked) => handleCheckboxChange(checked as boolean, "all")}
                      />
                    </div>
                  </TableHead>

                  {selection.length > 0 && (
                    <TableHead className="p-2" colSpan={10}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!compatibleTypeSelection(selection) || documentPrinter.isLoading}
                          className="px-3"
                          onClick={() => documentPrinter.openBatchLabels(
                            selection,
                            { format: (computeDocFormat(selection) || "pdf")?.toLowerCase() as FormatType, doc: "label" }
                          )}
                        >
                          {documentPrinter.isLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                          Print Labels
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={documentPrinter.isLoading}
                          className="px-3"
                          onClick={() => documentPrinter.openBatchLabels(
                            selection,
                            { format: "pdf", doc: "invoice" }
                          )}
                        >
                          {documentPrinter.isLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                          Print Invoices
                        </Button>
                        {(document_templates?.edges || []).map(
                          ({ node: template }) => (
                            <Button
                              key={template.id}
                              variant="outline"
                              size="sm"
                              disabled={documentPrinter.isLoading}
                              className="px-3"
                              onClick={() => documentPrinter.openTemplate(
                                template.id,
                                { shipments: selection.join(",") }
                              )}
                            >
                              {documentPrinter.isLoading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                              Print {template.name}
                            </Button>
                          ),
                        )}
                      </div>
                    </TableHead>
                  )}

                  {selection.length === 0 && (
                    <>
                      <TableHead className="service text-xs items-center">
                        SHIPPING SERVICE
                      </TableHead>
                      <TableHead className="status items-center"></TableHead>
                      <TableHead className="recipient text-xs items-center">
                        RECIPIENT
                      </TableHead>
                      <TableHead className="address text-xs items-center">
                        ADDRESS
                      </TableHead>
                      <TableHead className="rate text-xs items-center">
                        RATE
                      </TableHead>
                      <TableHead className="reference text-xs items-center">
                        REFERENCE
                      </TableHead>
                      <TableHead className="ship-date text-xs items-center">
                        SHIP DATE
                      </TableHead>
                      <TableHead className="delivery-date text-xs items-center">
                        DELIVERY
                      </TableHead>
                      <TableHead className="date text-xs items-center">DATE</TableHead>
                      <TableHead className="action sticky-right"></TableHead>
                    </>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleShipments.map(({ node: shipment }) => (
                  <TableRow 
                    key={shipment.id} 
                    className={`items cursor-pointer transition-colors duration-150 ease-in-out ${
                      selection.includes(shipment.id) 
                        ? 'bg-blue-50 hover:bg-blue-100' 
                        : 'hover:bg-gray-50'
                    }`}
                  >
                    <TableCell className="selector text-center items-center p-0 sticky-left">
                      <div className="py-3 pl-2 pr-4">
                        <Checkbox
                          checked={selection.includes(shipment.id)}
                          onCheckedChange={(checked) => handleCheckboxChange(checked as boolean, shipment.id)}
                        />
                      </div>
                    </TableCell>
                    <TableCell
                      className="service items-center py-1 px-0 text-xs font-bold text-gray-600"
                      onClick={() => previewShipment(shipment.id)}
                      title={
                        isNone(getRate(shipment))
                          ? "UNFULFILLED"
                          : formatRef(
                            ((shipment.meta as any)?.service_name ||
                              getRate(shipment).service) as string,
                          )
                      }
                    >
                        <div className="flex items-center">
                          <CarrierImage
                            carrier_name={
                              shipment.meta?.custom_carrier_name ||
                              shipment.meta?.carrier ||
                              getRate(shipment).meta?.rate_provider ||
                              getRate(shipment).carrier_name ||
                              formatCarrierSlug(references.APP_NAME)
                            }
                            containerClassName="mt-1 ml-1 mr-2"
                            height={28}
                            width={28}
                            text_color={
                              (
                                shipment.selected_rate_carrier ||
                                getCarrier(getRate(shipment))
                              )?.config?.text_color
                            }
                            background={
                              (
                                shipment.selected_rate_carrier ||
                                getCarrier(getRate(shipment))
                              )?.config?.brand_color
                            }
                          />
                          <div
                            className="text-ellipsis"
                            style={{ maxWidth: "190px", lineHeight: "16px" }}
                          >
                            <span className="text-blue-600 font-bold">
                              {!isNone(shipment.tracking_number) && (
                                <span>{shipment.tracking_number}</span>
                              )}
                              {isNone(shipment.tracking_number) && (
                                <span> - </span>
                              )}
                            </span>
                            <br />
                            <span className="text-ellipsis">
                              {!isNone(getRate(shipment).carrier_name) &&
                                formatRef(
                                  ((getRate(shipment).meta as any)
                                    ?.service_name ||
                                    getRate(shipment).service) as string,
                                )}
                              {isNone(getRate(shipment).carrier_name) &&
                                "UNFULFILLED"}
                            </span>
                          </div>
                        </div>
                    </TableCell>
                    <TableCell
                      className="status items-center"
                      onClick={() => previewShipment(shipment.id)}
                    >
                      <div style={{ paddingLeft: '7px', paddingRight: '7px' }}>
                        <ShipmentsStatusBadge
                          status={shipment.status as string}
                          className="w-full justify-center text-center"
                        />
                      </div>
                    </TableCell>
                    <TableCell
                      className="recipient items-center text-xs font-bold text-gray-600 relative"
                      onClick={() => previewShipment(shipment.id)}
                    >
                        <div
                          className="p-2"
                          style={{
                            position: "absolute",
                            maxWidth: "100%",
                            top: 0,
                            left: 0,
                          }}
                        >
                          <p
                            className="text-ellipsis font-bold"
                            title={formatAddressShort(
                              shipment.recipient as AddressType,
                            )}
                          >
                            {formatAddressShort(
                              shipment.recipient as AddressType,
                            )}
                          </p>
                          <p className="font-medium text-gray-500">
                            {[
                              (shipment.recipient as AddressType)?.city,
                              (shipment.recipient as AddressType)?.postal_code,
                              (shipment.recipient as AddressType)?.country_code,
                            ].filter(Boolean).join(", ")}
                          </p>
                        </div>
                    </TableCell>
                    <TableCell
                      className="address items-center text-xs"
                      onClick={() => previewShipment(shipment.id)}
                    >
                      {renderAddressReview(shipment.metadata, shipment.meta)}
                    </TableCell>
                    <TableCell
                      className="rate items-center text-xs text-gray-600"
                      onClick={() => previewShipment(shipment.id)}
                    >
                      {shipment.selected_rate ? (
                        <div style={{ lineHeight: "16px" }}>
                          <p className="font-bold">
                            {shipment.selected_rate.total_charge} {shipment.selected_rate.currency}
                          </p>
                          {shipment.selected_rate.transit_days && (
                            <p className="text-gray-400 font-medium">
                              {shipment.selected_rate.transit_days}-{shipment.selected_rate.transit_days + 2} days
                            </p>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </TableCell>
                    <TableCell
                      className="reference items-center text-xs text-gray-600 text-ellipsis"
                      onClick={() => previewShipment(shipment.id)}
                    >
                      {/* All three references of the ERP chain: the Shopify
                          number the customer knows, the Sales Order the office
                          knows, and the ERP shipment the warehouse works from.
                          Metadata keys are stamped by karrio_shipping; rows
                          from before that mirror simply show fewer lines. */}
                      <div style={{ lineHeight: "15px" }}>
                        {(shipment.metadata as any)?.shopify_order_number && (
                          <p className="text-xs font-bold">
                            {(shipment.metadata as any).shopify_order_number}
                          </p>
                        )}
                        <p className="text-xs font-semibold">
                          {shipment.reference || ""}
                        </p>
                        {(shipment.metadata as any)?.karrio_shipment && (
                          <p className="text-xs text-gray-400">
                            {(shipment.metadata as any).karrio_shipment}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell
                      className="ship-date items-center px-1"
                      onClick={() => previewShipment(shipment.id)}
                    >
                      {renderShipDate(shipment.metadata)}
                      {isTodayView && renderPrintOverdue(shipment.metadata)}
                    </TableCell>
                    <TableCell
                      className="delivery-date items-center px-1"
                      onClick={() => previewShipment(shipment.id)}
                    >
                      {renderDeliveryDate(shipment.metadata)}
                    </TableCell>
                    <TableCell
                      className="date items-center px-1"
                      onClick={() => previewShipment(shipment.id)}
                    >
                      <div style={{ lineHeight: "16px" }}>
                        <p className="text-xs font-semibold text-gray-600">
                          {formatDateTime(shipment.created_at)}
                        </p>
                        <p className="text-xs text-gray-400">
                          {formatDateTime(shipment.updated_at)}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="action items-center px-0 sticky-right">
                      <ShipmentMenu
                        shipment={shipment as any}
                        className="w-full"
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              </Table>
            </StickyTableWrapper>

            {/* Sticky Footer */}
            <div className="sticky bottom-0 left-0 right-0 z-10 bg-white border-t border-gray-200 pb-16 md:pb-0">
              <ListPagination
                currentOffset={filter.offset as number || 0}
                pageSize={20}
                totalCount={shipments?.page_info?.count || 0}
                hasNextPage={shipments?.page_info?.has_next_page || false}
                onPageChange={(offset) => updateFilter({ offset })}
                className="px-2 py-3"
              />
            </div>
          </>
        )}

        {!isFailedView && query.isFetched && visibleShipments.length == 0 && (
          <div className="bg-white rounded-lg shadow-sm border my-6">
            <div className="p-6 text-center">
              <p>No shipment found.</p>
            </div>
          </div>
        )}
      </>
    );
  };

  return (
    <FailedShipmentSheet>
      <ShipmentPreviewSheet>
        <Component />
      </ShipmentPreviewSheet>
    </FailedShipmentSheet>
  );
}
