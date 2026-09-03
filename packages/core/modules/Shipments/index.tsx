"use client";
import {
  errorToMessages,
  formatAddressShort,
  formatAddressLocationShort,
  formatDate,
  formatDateTime,
  formatRef,
  getURLSearchParams,
  isNone,
  isNoneOrEmpty,
  formatCarrierSlug,
  p,
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
import { StatusTimeline } from "@karrio/ui/components/status-timeline";
import { ListPagination } from "@karrio/ui/components/list-pagination";
import { StickyTableWrapper } from "@karrio/ui/components/sticky-table-wrapper";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@karrio/ui/components/ui/table";
import { Button } from "@karrio/ui/components/ui/button";
import { Checkbox } from "@karrio/ui/components/ui/checkbox";
import { Skeleton } from "@karrio/ui/components/ui/skeleton";
import {
  ChevronDown,
  GitCommitHorizontal,
  LayoutGrid,
  Loader2,
  Package,
} from "lucide-react";
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
import { useShipments, useShipmentMutation } from "@karrio/hooks/shipment";
import {
  DELIVERY_OUTCOME_OPTIONS,
  DeliveryOutcomeOption,
  useShipmentERPActions,
  markShippedAndMove,
  pickForPurchase,
  isERPLinked,
  canMarkPicked,
  getERPStatus,
} from "@karrio/hooks/erp-actions";
import { useBamboiFeatures } from "@karrio/hooks/bamboi-features";
import { ConfirmationDialog } from "@karrio/ui/components/confirmation-dialog";
import { ReasonPromptDialog } from "@karrio/ui/components/reason-prompt-dialog";
import {
  BuyResult,
  PicklistDialog,
  PicklistShipmentLike,
  PrintConfirmation,
} from "@karrio/ui/components/picklist-dialog";
import { useKarrio } from "@karrio/hooks/karrio";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@karrio/ui/components/ui/dropdown-menu";
import { useToast } from "@karrio/ui/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
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

// The All card and the initial query share this list. "draft" rides along
// since the All card started speaking card language (cardStatus below):
// a draft row there names its own card — Today, Planned, On hold, Needs
// Attention — instead of the Karrio status, so there is no longer any
// reason to keep drafts off the All card.
const ALL_STATUSES = [
  "draft",
  "created",
  "shipped",
  "delivered",
  "in_transit",
  "cancelled",
  "needs_attention",
  "out_for_delivery",
  "delivery_failed",
];

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

// The status badge on the All card speaks card language, not Karrio
// language. Five cards — Needs Attention, Complete, On hold, Planned,
// Today — are all Karrio status "draft" under the hood (deliberately: we
// never renamed the Karrio status itself, that would ripple through the
// server), so the raw badge said "draft" on rows the warehouse knows by
// their card name. Same predicates as the card narrowing in
// visibleShipments, so the label always names the card the row lives on.
// Complete never appears: it is the roll-up of Planned + Today, and the
// more specific of the two wins on a single row.
const cardStatus = (shipment: Pick<ShipmentType, "status" | "metadata">) => {
  const status = shipment.status as string;
  if (status === "draft") {
    if (hasAddressReviewFlag(shipment.metadata)) return "needs_attention";
    if (getShopifyHold(shipment.metadata).held) return "on_hold";
    // A draft the ERP already moved on (own delivery: picked, on the van,
    // delivered) is named by its erp_status — see ERP_DRAFT_CARDS.
    const erpCard = erpDraftCard(shipment.metadata);
    if (erpCard) return erpCard;
    const printDate = getPrintDate(shipment.metadata);
    if (printDate && printDate > amsterdamToday()) return "planned";
    return "today";
  }
  // "created" (REST) / "purchased" (GraphQL) is the labeled-not-scanned
  // state the board calls Picked.
  if (status === "created" || status === "purchased") return "picked";
  if (["shipped", "in_transit", "out_for_delivery"].includes(status))
    return "shipped";
  if (["needs_attention", "delivery_failed"].includes(status))
    return "exception";
  // delivered / cancelled already carry the card's name.
  return status;
};

// Amsterdam calendar days between two ISO dates. Both parse as UTC midnight,
// so the difference is an exact whole number of days.
const daysBetween = (fromISODate: string, toISODate: string) =>
  Math.round((Date.parse(toISODate) - Date.parse(fromISODate)) / 86400000);

// How the parcel leaves the warehouse, mirrored onto every shipment by the
// ERP sync. Own delivery rides our own van and never buys a carrier label.
const FULFILMENT_MODE_KEY = "fulfilment_mode";
const isSelfDelivery = (metadata: unknown) =>
  ((metadata || {}) as Record<string, unknown>)[FULFILMENT_MODE_KEY] ===
  "self_delivery";

// Own delivery never buys a label, so its Karrio status stays "draft" for the
// parcel's whole life — but the board must still move those rows: a picked
// parcel belongs on Picked, a van on the road on Shipped. For drafts the
// mirrored erp_status therefore decides the card. Anything unmapped (Synced,
// no mirror yet) stays in the print worklist; a terminal/exception erp_status
// (Returned, Delivery Failed) at least leaves the worklist instead of posing
// as work — seen live: two Returned test rows from 7 Aug squatting on Today.
const ERP_DRAFT_CARDS: Record<string, string> = {
  Picked: "picked",
  "Out for Delivery": "shipped",
  Delivered: "delivered",
  "Delivery Failed": "exception",
  Returned: "exception",
  Cancelled: "cancelled",
};
const erpDraftCard = (metadata: unknown): string | null =>
  ERP_DRAFT_CARDS[getERPStatus(metadata) || ""] || null;

// The route line: the one fact that decides how a row ships, rendered once in
// the service column. "Monta → PostNL" is the ERP-mirrored checkout choice
// (metadata.shipping_method); older drafts miss that key until their next
// metadata mirror and read plain "Monta". Non-ERP rows return null and keep
// Karrio's own service rendering.
const routeLabel = (metadata: unknown): string | null => {
  const values = (metadata || {}) as Record<string, unknown>;
  const mode = values[FULFILMENT_MODE_KEY] as string | undefined;
  if (!mode) return null;
  if (mode === "self_delivery") return "Eigen bezorging";
  if (mode === "external") return "External (DHL)";
  const method = (values["shipping_method"] as string | undefined)?.trim();
  return method ? `Monta → ${method}` : "Monta";
};

// The name the warehouse actually works with. Karrio ids mean nothing on the
// floor, so batch reports quote the Shopify order number and fall back to the
// id only when the ERP has not mirrored one.
const SHOPIFY_ORDER_NUMBER_KEY = "shopify_order_number";
const shipmentLabel = (shipment: Pick<ShipmentType, "id" | "metadata">) => {
  const value = ((shipment.metadata || {}) as Record<string, unknown>)[
    SHOPIFY_ORDER_NUMBER_KEY
  ];
  return typeof value === "string" || typeof value === "number"
    ? `${value}`
    : shipment.id;
};

// The operator's page-size choice for the worklist. Remembered across
// sessions in localStorage; the URL (setVariablesToURL) carries it within
// one. The footer only mounts after the client-side fetch, so reading
// localStorage in the state initializer can never cause a hydration
// mismatch.
const PAGE_SIZE_OPTIONS = [20, 50, 100];
const PAGE_SIZE_STORAGE_KEY = "shipments_page_size";
const DEFAULT_PAGE_SIZE = 20;
const initialPageSize = () => {
  if (typeof window === "undefined") return DEFAULT_PAGE_SIZE;
  try {
    const stored = parseInt(
      window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY) || "",
      10,
    );
    return PAGE_SIZE_OPTIONS.includes(stored) ? stored : DEFAULT_PAGE_SIZE;
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
};

// How the status views are presented: the lifecycle timeline (default) or
// the classic grid of cards. Same views, same filters — only the shape
// differs. Remembered per browser in localStorage; read in an effect (not
// the state initializer) so the server and first client render agree and
// there is no hydration mismatch.
type ViewMode = "timeline" | "cards";
const VIEW_MODE_STORAGE_KEY = "shipments_view_mode";
const DEFAULT_VIEW_MODE: ViewMode = "timeline";
const readStoredViewMode = (): ViewMode => {
  try {
    const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return stored === "cards" || stored === "timeline"
      ? stored
      : DEFAULT_VIEW_MODE;
  } catch {
    return DEFAULT_VIEW_MODE;
  }
};

// errorToMessages yields either strings or API message objects; flatten both
// into one operator-readable line (same shape shipment-menu.tsx renders).
const describeError = (error: unknown) =>
  errorToMessages(error)
    .map((message: unknown) =>
      typeof message === "string"
        ? message
        : (message as { message?: string })?.message || JSON.stringify(message),
    )
    .join("; ");

// How a post-purchase row can end, offered from the Shipped card onward.
// The options (and the double-write contract) live in
// @karrio/hooks/erp-actions so the per-row menu offers the exact same list.
type OutcomeOption = DeliveryOutcomeOption;

const OUTCOME_OPTIONS = DELIVERY_OUTCOME_OPTIONS;

export default function Page(pageProps: any) {
  const Component = (): JSX.Element => {
    const searchParams = useSearchParams();
    const { setLoading } = useLoader();
    const { references } = useAPIMetadata();
    const [allChecked, setAllChecked] = React.useState(false);
    const [initialized, setInitialized] = React.useState(false);
    const [selection, setSelection] = React.useState<string[]>([]);
    // Rows per page (20/50/100), fed into the query as filter.first.
    const [pageSize, setPageSize] = React.useState<number>(initialPageSize);
    const [viewMode, setViewMode] = React.useState<ViewMode>(DEFAULT_VIEW_MODE);
    useEffect(() => {
      setViewMode(readStoredViewMode());
    }, []);
    const switchViewMode = (mode: ViewMode) => {
      setViewMode(mode);
      try {
        window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
      } catch {
        // Private mode / blocked storage: the choice just lives for this page.
      }
    };
    // Anchor of the last individually clicked row checkbox, for shift+click
    // range selection. Stored as a shipment id, not an index: ids survive
    // refetches and the client-side re-narrowing/sorting of visibleShipments
    // where positions do not.
    const lastCheckedRef = React.useRef<string | null>(null);
    // Which sequential bulk run (if any) is in flight — the buttons disable
    // each other so two batches can never interleave over one selection.
    const [bulkAction, setBulkAction] = React.useState<
      | "buy_and_print"
      | "mark_picked"
      | "mark_shipped"
      | "mark_out_for_delivery"
      | "cancel_shipment"
      | "record_outcome"
      | null
    >(null);
    // Cancelling cannot be undone, and the outcome actions record a reason —
    // both go through a dialog before the batch starts.
    const [cancelDialogOpen, setCancelDialogOpen] = React.useState(false);
    // Mark out for delivery creates the Shopify fulfillment and mails the
    // customer — irreversible, so it is confirmed like Cancel is.
    const [ofdDialogOpen, setOfdDialogOpen] = React.useState(false);
    const [outcomePrompt, setOutcomePrompt] =
      React.useState<OutcomeOption | null>(null);
    // The pick list: null = closed, otherwise the frozen shipment scope it
    // was opened over (frozen so a refetch mid-pick cannot reshuffle the
    // rack walk under the picker's feet). Structurally typed: the list rows
    // (edges nodes) are not the full ShipmentType, and the dialog only reads
    // id/metadata/parcels anyway.
    const [picklistShipments, setPicklistShipments] = React.useState<
      PicklistShipmentLike[] | null
    >(null);
    // Labels bought in the popup so far, for its "open the PDFs" fallback
    // (the day PrintNode or the printer is down).
    const [picklistPurchasedIds, setPicklistPurchasedIds] = React.useState<
      string[]
    >([]);
    // The frozen scope as FULL rows: the popup's structural type strips the
    // fields buyLabel needs (rates, options, ...), so the buy handler reads
    // the originals from here instead of casting the narrowed state back up.
    const picklistRowsRef = React.useRef<ReturnType<typeof selectedShipments>>(
      [],
    );
    const { previewShipment } = useContext(ShipmentPreviewSheetContext);
    const { user_connections } = useCarrierConnections();
    const { system_connections } = useSystemConnections();
    const documentPrinter = useDocumentPrinter();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const mutation = useShipmentMutation();
    const karrio = useKarrio();
    // Bamboi fork: warehouse actions relayed to the ERP (Ship Today phase 2).
    const erpActions = useShipmentERPActions();
    // Same flags as the per-row menu: until the ERP registry loads, the
    // identical client-side defaults answer, so the toolbar never flickers.
    const { isEnabled } = useBamboiFeatures();
    const context = useShipments({
      status: ALL_STATUSES as any,
      first: pageSize,
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
    // Same server-side count for the address worklist: without a number the
    // card only says a worklist *exists* — the operator has to open it to
    // learn whether one address needs fixing or thirty. Status "draft" keeps
    // cancelled rows that still carry the flag (pre-cleanup tombstones) out
    // of the count, exactly like the card's own filter.
    const reviewBadge = useShipments({
      status: ["draft"] as any,
      metadata_key: ADDRESS_REVIEW_FLAG,
      first: 1,
      cacheKey: "shipments-badge-review",
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
    // Applied on the next render via filter.first; localStorage remembers
    // the choice across sessions, the URL carries it within one. Back to
    // offset 0 — the old offset may not even exist under the new page size.
    const changePageSize = (size: number) => {
      setPageSize(size);
      try {
        window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, `${size}`);
      } catch {
        // Storage refused (private mode) — the choice still applies now.
      }
      updateFilter({ first: size, offset: 0 });
    };
    const handleCheckboxChange = (checked: boolean, name: string) => {
      if (name === "all") {
        lastCheckedRef.current = null;
        setSelection(
          !checked ? [] : visibleShipments.map(({ node: { id } }) => id),
        );
      } else {
        lastCheckedRef.current = name;
        setSelection(
          checked
            ? [...selection, name]
            : selection.filter((id) => id !== name),
        );
      }
    };
    // Shift+click selects (or deselects — the clicked checkbox's own
    // direction decides) every row between the previous click and this one.
    // Radix's onCheckedChange carries no modifier keys, so the shift
    // detection lives on the checkbox's click event; preventDefault() stops
    // Radix from also toggling (its composed handlers bail on
    // defaultPrevented), making the range write below the only state change.
    const handleSelectorClick = (event: React.MouseEvent, id: string) => {
      const anchor = lastCheckedRef.current;
      if (!event.shiftKey || !anchor || anchor === id) return;
      const ids = visibleShipments.map(({ node: shipment }) => shipment.id);
      const from = ids.indexOf(anchor);
      const to = ids.indexOf(id);
      // Anchor no longer on this page/view — fall back to a plain toggle.
      if (from === -1 || to === -1) return;
      event.preventDefault();
      const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
      const selecting = !selection.includes(id);
      setSelection(
        selecting
          ? Array.from(new Set([...selection, ...range]))
          : selection.filter((selected) => !range.includes(selected)),
      );
      lastCheckedRef.current = id;
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
    // The All card carries drafts since it learned card language, and a
    // draft has no label to print — one in the selection would poison the
    // whole batch, so Print Labels greys out instead of failing halfway.
    const selectionHasDraft = (selection: string[]) =>
      (shipments?.edges || []).some(
        ({ node: shipment }) =>
          selection.includes(shipment.id) && shipment.status === "draft",
      );
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

    // Colli at a glance: how many labels a buy on this row is going to
    // produce. parcels is filled by the ERP sync and, once the label is
    // bought, equals the label count exactly. One collo is the norm and
    // stays silent — only multi-colli rows get the chip, with the parcel
    // contents (product title × quantity, no parsing of the titles) in the
    // native title tooltip this file already uses everywhere.
    const renderColli = (shipment: Pick<ShipmentType, "parcels">) => {
      const parcels = shipment.parcels || [];
      if (parcels.length <= 1) return null;
      const contents = parcels
        .flatMap((parcel) => parcel.items || [])
        .map(
          (item) =>
            `${item.quantity ?? 1} × ${item.title || item.description || item.sku || "item"}`,
        );
      const title =
        contents.length > 0 ? contents.join("\n") : `${parcels.length} colli`;
      return (
        <span
          className="inline-flex items-center gap-0.5 rounded bg-gray-100 text-gray-600 text-xs font-semibold px-1 py-0.5 mr-1 shrink-0"
          title={title}
        >
          <Package className="h-3 w-3" />
          {parcels.length}×
        </span>
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
    // Exact for the same reason; shown even when 0 so "nothing to fix" is a
    // statement, not an absence.
    const reviewCount = reviewBadge.query.data?.shipments?.page_info?.count;
    const reviewBadgeLabel = reviewCount == null ? undefined : `${reviewCount}`;

    // The cards follow the shipment lifecycle left-to-right: fix addresses
    // (Needs Attention) → clean drafts (Complete) → parked drafts (On hold) →
    // print later (Planned) → print now (Today) → labeled, waiting for the
    // carrier (Picked) → on the road (Shipped) → Delivered, with the failure
    // buckets at the end.
    const getFilterOptions = () => [
      {
        label: "All",
        value: ALL_STATUSES,
        kind: "all" as const,
      },
      {
        // The address worklist: every DRAFT whose delivery address is
        // flagged Suspect/Invalid and waits on a human decision. Keyed on the
        // metadata flag the ERP stamps (the status filter alone cannot
        // isolate it — flagged drafts are ordinary "draft" rows), but the
        // "draft" status still rides along: an address-review flag is by
        // definition a property of a draft, and once the shipment is
        // purchased or cancelled it is no longer actionable here. Without it
        // the sentinel is stripped before the query (useShipments) and the
        // card would send NO status constraint at all, so cancelled and
        // delivered rows that still carry the flag would show up. Filtering
        // fully server-side also makes this card's pagination count exact.
        label: "Needs Attention",
        value: ["draft", ADDRESS_REVIEW_SENTINEL],
        badge: reviewBadgeLabel,
        hint: "Drafts whose delivery address needs a human decision",
      },
      {
        // Every draft whose address review is done or was never needed —
        // status "draft" minus the Needs Attention worklist. (Renames the old
        // Draft card; the backend status is still "draft".)
        label: "Complete",
        value: ["draft", COMPLETE_SENTINEL],
        hint: "Every clean draft (Planned + Today)",
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
        hint: "Parked: the Shopify order is on hold",
      },
      {
        // Clean drafts whose print day is still ahead.
        label: "Planned",
        value: ["draft", PLANNED_SENTINEL],
        hint: "Clean drafts whose print day is still ahead",
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
        hint: "The printlist: due and overdue drafts",
      },
      {
        // Labeled but not yet handed to the carrier ("purchased" is aliased
        // to "created" by useShipments) — plus own-delivery drafts whose
        // mirrored erp_status says Picked: own delivery never buys a label,
        // so "draft" rides along and visibleShipments narrows the drafts to
        // the picked ones. Same accepted per-page narrowing limitation as
        // Complete/Planned/Today.
        label: "Picked",
        value: ["created", "draft"],
        hint: "Labeled, waiting for the carrier",
      },
      {
        label: "Shipped",
        value: ["shipped", "in_transit", "out_for_delivery"],
        hint: "On the road",
      },
      {
        label: "Delivered",
        value: ["delivered"],
      },
      // The three buckets below are where shipments end up when they leave
      // the line — the timeline draws them on a branch under the track.
      {
        label: "Exception",
        value: ["needs_attention", "delivery_failed"],
        kind: "outcome" as const,
        hint: "Carrier exceptions and failed deliveries",
      },
      {
        label: "Cancelled",
        value: ["cancelled"],
        kind: "outcome" as const,
      },
      {
        label: "Failed",
        value: [FAILED_SENTINEL],
        kind: "outcome" as const,
        hint: "Shipments that could not be created",
      },
    ];

    const statusFilter = ([] as string[]).concat((filter?.status as any) || []);
    const isFailedView = statusFilter.includes(FAILED_SENTINEL);
    const isCompleteView = statusFilter.includes(COMPLETE_SENTINEL);
    const isPlannedView = statusFilter.includes(PLANNED_SENTINEL);
    const isTodayView = statusFilter.includes(TODAY_SENTINEL);
    const isHoldView = statusFilter.includes(HOLD_SENTINEL);
    // The Picked card is exactly status=["created","draft"] (the drafts are
    // the own-delivery picked rows, narrowed in visibleShipments). Membership
    // alone would also match the All card (which contains both among eight
    // other statuses), so the bulk buttons key on the exact filter.
    const isPickedView =
      statusFilter.length === 2 &&
      statusFilter.includes("created") &&
      statusFilter.includes("draft");
    const isNeedsAttentionView = statusFilter.includes(ADDRESS_REVIEW_SENTINEL);
    // The five draft-stage cards. A row on any of them is still a draft — a
    // purchased shipment is no longer "draft" — so it can never have a label
    // (Print Labels is dead there) and cancelling it is always meaningful.
    const isDraftStageView =
      isNeedsAttentionView ||
      isCompleteView ||
      isHoldView ||
      isPlannedView ||
      isTodayView;
    // Exact set match, for the same reason isPickedView is exact: the All
    // card contains every one of these statuses, so membership alone would
    // light the outcome dropdown up there too.
    const matchesCard = (statuses: string[]) =>
      statusFilter.length === statuses.length &&
      statuses.every((status) => statusFilter.includes(status));
    // The one view where the status column renders: every other card IS a
    // status, so a per-row badge there repeats the card header at best — and
    // at worst says "draft" on five differently-named cards, which is
    // exactly the confusion that got the column hidden.
    const isAllView = matchesCard(ALL_STATUSES);
    // Shipped / Delivered / Exception — the post-purchase cards, where a
    // delivery can still turn out differently than the carrier reported.
    const isPostPurchaseView =
      matchesCard(["shipped", "in_transit", "out_for_delivery"]) ||
      matchesCard(["delivered"]) ||
      matchesCard(["needs_attention", "delivery_failed"]);

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
      if (isPickedView) {
        // "created" rows are picked by definition; a draft is only here when
        // its erp_status says so (own delivery — see ERP_DRAFT_CARDS).
        return edges.filter(
          ({ node: shipment }) =>
            shipment.status !== "draft" ||
            erpDraftCard(shipment.metadata) === "picked",
        );
      }
      if (!isCompleteView && !isPlannedView && !isTodayView) return edges;
      const today = amsterdamToday();
      const narrowed = edges.filter(({ node: shipment }) => {
        if (hasAddressReviewFlag(shipment.metadata)) return false;
        // Held orders are parked on the On hold card — never in the print
        // worklist, elapsed print_date or not.
        if (getShopifyHold(shipment.metadata).held) return false;
        // A draft the ERP already moved on (own delivery picked / on the
        // van / delivered / returned) has left the print worklist — its card
        // is named by erpDraftCard, matching the cardStatus badge.
        if (erpDraftCard(shipment.metadata)) return false;
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
    }, [
      shipments,
      isCompleteView,
      isPlannedView,
      isTodayView,
      isHoldView,
      isPickedView,
    ]);

    // The selected rows of the current page, in the order the operator sees
    // them. Bulk actions work over visibleShipments (not shipments.edges), so
    // a client-side narrowed view can never act on a row it does not show.
    const selectedShipments = () =>
      visibleShipments
        .filter(({ node: shipment }) => selection.includes(shipment.id))
        .map(({ node: shipment }) => shipment);

    // One destructive toast per batch, listing the rows by the number the
    // warehouse recognises — mirrors the ERP's own mark_picked_bulk report.
    const reportBulkFailures = (title: string, failures: string[]) => {
      if (failures.length === 0) return;
      toast({
        variant: "destructive",
        title: `${title}: ${failures.length} failed`,
        description: failures.join(" | "),
      });
    };

    // Pick & Print opens the run popup and nothing else: no purchase leaves
    // this handler anymore. Buying moved into the popup's per-row Print so
    // the labels always come out next to the stack of boxes they belong to.
    // The scope is frozen at open — purchases move rows off this card, and a
    // live scope would shrink the list while the picker is walking it. Own
    // delivery rides along: it buys no label, but its items must be picked
    // for the van all the same.
    const openPickAndPrint = () => {
      const selected = selectedShipments();
      if (selected.length === 0) return;
      picklistRowsRef.current = selected;
      setPicklistPurchasedIds([]);
      setPicklistShipments([...selected]);
    };

    // One popup row's purchase run (a SKU stack, or one mixed order).
    // Strictly SEQUENTIAL: parallel purchases would race Monta's
    // verification window and the ERP's row locks. A failing shipment is
    // collected and the row continues, exactly like the ERP's
    // mark_picked_bulk.
    const buyPicklistShipments = async (ids: string[]): Promise<BuyResult> => {
      const byId = new Map(picklistRowsRef.current.map((row) => [row.id, row]));
      const targets = ids.flatMap((id) => byId.get(id) ?? []);

      setBulkAction("buy_and_print");
      const purchased: string[] = [];
      const failures: string[] = [];
      const failedIds: string[] = [];
      const unrecordedPicks: string[] = [];

      for (const shipment of targets) {
        try {
          // BEFORE the purchase on purpose: the ERP's mark_picked only
          // accepts a shipment in status "Synced", and buying the label moves
          // the ERP row to "Label Created" — pick after buy would always be
          // refused. This ordering is the whole reason the two calls are not
          // swapped.
          //
          // Best-effort, though (pickForPurchase): a row that is already
          // picked is skipped rather than asked again, and a refused pick is
          // collected instead of costing the row its label — the purchase
          // runs the ERP's real gate by itself and fails closed.
          const pick = await pickForPurchase(erpActions.markPicked, shipment);
          if (pick.error) {
            unrecordedPicks.push(
              `${shipmentLabel(shipment)}: ${describeError(pick.error)}`,
            );
          }
          await mutation.buyLabel.mutateAsync({
            ...shipment,
            id: shipment.id,
            selected_rate_id:
              shipment.selected_rate?.id ?? shipment.rates?.[0]?.id,
          } as ShipmentType);
          purchased.push(shipment.id);
        } catch (error) {
          failures.push(`${shipmentLabel(shipment)}: ${describeError(error)}`);
          failedIds.push(shipment.id);
        }
      }

      setBulkAction(null);
      queryClient.invalidateQueries(["shipments"]);

      // The physical print is PrintNode's job (the ERP auto-prints on the
      // purchase webhook); the popup's footer keeps a PDF fallback over
      // everything bought so far for the day the printer is down.
      if (purchased.length > 0) {
        setPicklistPurchasedIds((current) => [...current, ...purchased]);
      }
      // Said out loud, not swallowed: the labels are bought, but these rows
      // carry no pick in the ERP and the office should know which.
      if (unrecordedPicks.length > 0) {
        toast({
          title: `${unrecordedPicks.length} pick(s) not recorded`,
          description: `The label was bought anyway: ${unrecordedPicks.join(" | ")}`,
        });
      }
      reportBulkFailures("Pick & Print", failures);
      return { purchased, failures, failedIds };
    };

    // The popup's green tick: poll the bought shipments until the ERP has
    // mirrored printed_at — stamped only after PrintNode reported the jobs
    // DELIVERED to the printer host ("done"), not merely accepted — or give
    // up. The window is wide on purpose: behind it sit the purchase webhook
    // (short queue, re-enqueued up to 5× on row locks), the ERP's auto-print
    // and its own delivery-confirmation poll. Every request carries its own
    // timeout so one stalled connection cannot hold the dialog past the
    // deadline, and the first check runs immediately — the mirror often
    // already landed by the time the purchase returns.
    const PRINT_CONFIRM_TIMEOUT_MS = 90_000;
    const PRINT_CONFIRM_POLL_MS = 3_000;
    const awaitPrinted = async (ids: string[]): Promise<PrintConfirmation> => {
      const deadline = Date.now() + PRINT_CONFIRM_TIMEOUT_MS;
      const pending = new Set(ids);
      const printed: string[] = [];
      while (pending.size > 0) {
        for (const id of Array.from(pending)) {
          try {
            const { data } = await karrio.axios.get<{
              metadata?: Record<string, unknown>;
            }>(`/v1/shipments/${id}`, { timeout: 10_000 });
            if ((data?.metadata || {})["printed_at"]) {
              pending.delete(id);
              printed.push(id);
            }
          } catch {
            // Transient read failure: keep polling until the deadline; the
            // verdict is the printer's, not the network's.
          }
        }
        if (pending.size === 0 || Date.now() >= deadline) break;
        await new Promise((resolve) =>
          setTimeout(resolve, PRINT_CONFIRM_POLL_MS),
        );
      }
      return { printed, unconfirmed: Array.from(pending) };
    };

    // The popup's closing confirmation. Carrier rows recorded their pick at
    // purchase; the own-delivery rows get theirs here, so "alles bevestigd"
    // also means "alles geregistreerd". Best-effort, same as everywhere: a
    // refused pick is reported, never a blocker.
    const confirmPicklistRun = async (ownIds: string[]) => {
      const byId = new Map(picklistRowsRef.current.map((row) => [row.id, row]));
      const targets = ownIds
        .flatMap((id) => byId.get(id) ?? [])
        .filter(
          ({ metadata }) => isERPLinked(metadata) && canMarkPicked(metadata),
        );

      const failures: string[] = [];
      let recorded = 0;
      for (const shipment of targets) {
        try {
          await erpActions.markPicked.mutateAsync({ id: shipment.id });
          recorded += 1;
        } catch (error) {
          failures.push(`${shipmentLabel(shipment)}: ${describeError(error)}`);
        }
      }

      toast({
        title: "Pick & Print run confirmed",
        description:
          recorded > 0
            ? `${recorded} own-delivery pick(s) recorded in the ERP.`
            : "All rows confirmed.",
      });
      reportBulkFailures("Own-delivery picks", failures);
    };

    // Today's own-delivery (and pick-without-print) run: record the pick in
    // the ERP, nothing else — no label, no Shopify call, no customer mail.
    // The ERP mirrors erp_status=Picked back onto the metadata, which is what
    // moves the row to the Picked card on the delayed refetch
    // (invalidateAroundMirror in the mutation hook). Rows the mirrored status
    // already rules out are named up front instead of refused one by one.
    const runMarkPicked = async () => {
      const selected = selectedShipments();
      const pickable = ({ metadata }: { metadata?: unknown }) =>
        isERPLinked(metadata) && canMarkPicked(metadata);
      const skipped = selected.filter((shipment) => !pickable(shipment));
      const targets = selected.filter(pickable);

      if (skipped.length > 0) {
        toast({
          title: `${skipped.length} row(s) skipped`,
          description: `Niet pickbaar (geen ERP-koppeling, of al voorbij Synced): ${skipped
            .map(shipmentLabel)
            .join(", ")}`,
        });
      }
      if (targets.length === 0) return;

      setBulkAction("mark_picked");
      const failures: string[] = [];
      let succeeded = 0;

      for (const shipment of targets) {
        try {
          await erpActions.markPicked.mutateAsync({ id: shipment.id });
          succeeded += 1;
        } catch (error) {
          failures.push(`${shipmentLabel(shipment)}: ${describeError(error)}`);
        }
      }

      setBulkAction(null);
      queryClient.invalidateQueries(["shipments"]);

      if (succeeded > 0) {
        toast({
          title: `${succeeded} shipment(s) marked picked`,
          description:
            "De rijen verhuizen naar de Picked-kaart. Er is niets naar Shopify of de klant gestuurd.",
        });
      }
      reportBulkFailures("Mark picked", failures);
    };

    // Own delivery's departure: the ERP creates the Shopify fulfillment and
    // notifies the customer, so this only ever runs behind the confirmation
    // dialog. Self-delivery rows only — a carrier row's hand-over is Mark
    // shipped — and the ERP re-checks its own gates per row.
    const runMarkOutForDelivery = async () => {
      const selected = selectedShipments();
      const skipped = selected.filter(
        ({ metadata }) => !isSelfDelivery(metadata),
      );
      const targets = selected.filter(({ metadata }) =>
        isSelfDelivery(metadata),
      );

      if (skipped.length > 0) {
        toast({
          title: `${skipped.length} carrier shipment(s) skipped`,
          description: `Vervoerderszendingen vertrekken met Mark shipped: ${skipped
            .map(shipmentLabel)
            .join(", ")}`,
        });
      }
      if (targets.length === 0) return;

      setBulkAction("mark_out_for_delivery");
      const failures: string[] = [];
      let succeeded = 0;

      for (const shipment of targets) {
        try {
          await erpActions.markOutForDelivery.mutateAsync({ id: shipment.id });
          succeeded += 1;
        } catch (error) {
          failures.push(`${shipmentLabel(shipment)}: ${describeError(error)}`);
        }
      }

      setBulkAction(null);
      queryClient.invalidateQueries(["shipments"]);

      if (succeeded > 0) {
        toast({
          title: `${succeeded} shipment(s) out for delivery`,
          description:
            "De Shopify-fulfillment is aangemaakt en de klant is op de hoogte. De rijen verhuizen naar de Shipped-kaart.",
        });
      }
      reportBulkFailures("Mark out for delivery", failures);
    };

    // Picked → In Transit in the ERP AND on the board: markShippedAndMove
    // flips Karrio's own status too, so the rows leave the Picked card on
    // the refetch instead of waiting for the carrier's first scan. No
    // confirmation; same sequential loop and per-row error collection.
    // Own-delivery rows are named and skipped — their departure is Mark out
    // for delivery, and the ERP would refuse them one by one anyway.
    const runMarkShipped = async () => {
      const selected = selectedShipments();
      const skipped = selected.filter(({ metadata }) =>
        isSelfDelivery(metadata),
      );
      const targets = selected.filter(
        ({ metadata }) => !isSelfDelivery(metadata),
      );

      if (skipped.length > 0) {
        toast({
          title: `${skipped.length} own-delivery shipment(s) skipped`,
          description: `Eigen bezorging vertrekt met Mark out for delivery: ${skipped
            .map(shipmentLabel)
            .join(", ")}`,
        });
      }
      if (targets.length === 0) return;

      setBulkAction("mark_shipped");
      const failures: string[] = [];
      const unmoved: string[] = [];
      let succeeded = 0;

      for (const shipment of targets) {
        try {
          const { moved } = await markShippedAndMove(
            erpActions.markShipped,
            mutation.changeStatus,
            shipment,
          );
          if (!moved) unmoved.push(shipmentLabel(shipment));
          succeeded += 1;
        } catch (error) {
          failures.push(`${shipmentLabel(shipment)}: ${describeError(error)}`);
        }
      }

      setBulkAction(null);
      queryClient.invalidateQueries(["shipments"]);

      if (succeeded > 0) {
        toast({
          title: `${succeeded} shipment(s) marked shipped`,
          description: "De rijen verhuizen naar de Shipped-kaart.",
        });
      }
      // ERP recorded the hand-over but Karrio refused the status flip — the
      // row stays on Picked until the carrier scans. Named, not swallowed.
      if (unmoved.length > 0) {
        toast({
          title: `${unmoved.length} row(s) not moved`,
          description: `In het ERP verwerkt, maar de rij blijft op Picked tot de eerste carrier-scan: ${unmoved.join(", ")}`,
        });
      }
      reportBulkFailures("Mark shipped", failures);
    };

    // Draft cards only: the ERP cancels the Karrio draft itself, clears the
    // address-review flag and reports back whether the Monta order still has
    // to be removed by hand. That note is the response message — it is worth
    // more than a generic success line, so the toast quotes it per row.
    // Same sequential loop and per-row error collection as the other runners.
    const runCancelShipments = async () => {
      const targets = selectedShipments();
      if (targets.length === 0) return;

      setBulkAction("cancel_shipment");
      const notes: string[] = [];
      const failures: string[] = [];
      let succeeded = 0;

      for (const shipment of targets) {
        try {
          const { message } = await erpActions.cancelShipment.mutateAsync({
            id: shipment.id,
          });
          if (message) notes.push(`${shipmentLabel(shipment)}: ${message}`);
          succeeded += 1;
        } catch (error) {
          failures.push(`${shipmentLabel(shipment)}: ${describeError(error)}`);
        }
      }

      setBulkAction(null);
      queryClient.invalidateQueries(["shipments"]);

      if (succeeded > 0) {
        toast({
          title: `${succeeded} shipment(s) cancelled`,
          description:
            notes.length > 0
              ? notes.join(" | ")
              : "De zending is geannuleerd; de Sales Order blijft staan.",
        });
      }
      reportBulkFailures("Cancel", failures);
    };

    // Post-purchase cards: record how the delivery ended. Two writes per row,
    // ERP first — the ERP is where the reason is kept, and a row that moved
    // card without a recorded reason is worse than one that did not move, so
    // the Karrio status only follows a successful ERP write.
    const runRecordOutcome = async (option: OutcomeOption, note = "") => {
      const targets = selectedShipments();
      if (targets.length === 0) return;

      setBulkAction("record_outcome");
      const failures: string[] = [];
      let succeeded = 0;
      let moved = 0;
      let stuck = 0;

      for (const shipment of targets) {
        try {
          await erpActions.recordDeliveryOutcome.mutateAsync({
            id: shipment.id,
            outcome: option.outcome,
            note,
          });
          // A tracked shipment's status belongs to the carrier; the operator
          // may override it only with a reason (recorded server-side onto
          // metadata.status_override for the audit). The reason from the
          // dialog is passed along, so the override is allowed — but a
          // refusal here must never fail the row: the ERP already has the
          // outcome on the record, and reporting it as lost would be a lie.
          try {
            await mutation.changeStatus.mutateAsync({
              id: shipment.id,
              status: option.status,
              ...(note ? { reason: note } : {}),
            });
            moved += 1;
          } catch {
            stuck += 1;
          }
          succeeded += 1;
        } catch (error) {
          failures.push(`${shipmentLabel(shipment)}: ${describeError(error)}`);
        }
      }

      setBulkAction(null);
      queryClient.invalidateQueries(["shipments"]);

      if (succeeded > 0) {
        toast({
          title: `${succeeded} shipment(s) marked ${option.label.toLowerCase()}`,
          description: stuck
            ? `Recorded in the ERP. ${moved} row(s) moved card; ${stuck} stayed put because Karrio tracks them itself — the ERP has the outcome either way.`
            : `Recorded in the ERP and moved to ${formatRef(option.status.toString())}.`,
        });
      }
      reportBulkFailures(`Record ${option.label.toLowerCase()}`, failures);
    };

    // Delivered speaks for itself; the other three must carry a reason, so
    // they detour through the prompt dialog first.
    const selectOutcome = (option: OutcomeOption) =>
      option.requiresReason
        ? setOutcomePrompt(option)
        : runRecordOutcome(option);

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

    // Shared by both presentations. Needs Attention and On hold both filter
    // on an ERP-stamped metadata key server-side; every other view must
    // clear it or its status filter would intersect with those worklists.
    const onStatusFilterChange = (status: string[]) =>
      updateFilter({
        status,
        metadata_key: status.includes(ADDRESS_REVIEW_SENTINEL)
          ? ADDRESS_REVIEW_FLAG
          : status.includes(HOLD_SENTINEL)
            ? SHOPIFY_HOLD_KEY
            : undefined,
        offset: 0,
      });

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
            {/* Timeline / cards: two presentations of the same status views. */}
            <div
              role="group"
              aria-label="Status view"
              className="mx-1 inline-flex rounded-md border border-gray-200 bg-white p-0.5"
            >
              {(
                [
                  {
                    mode: "timeline",
                    Icon: GitCommitHorizontal,
                    label: "Timeline",
                  },
                  { mode: "cards", Icon: LayoutGrid, label: "Cards" },
                ] as const
              ).map(({ mode, Icon, label }) => (
                <button
                  key={mode}
                  type="button"
                  title={`${label} view`}
                  aria-pressed={viewMode === mode}
                  onClick={() => switchViewMode(mode)}
                  className={
                    "rounded-[5px] p-1.5 transition-colors duration-200 " +
                    (viewMode === mode
                      ? "bg-blue-600 text-white shadow-sm"
                      : "text-gray-500 hover:bg-gray-100 hover:text-gray-800")
                  }
                >
                  <Icon className="h-4 w-4" />
                  <span className="sr-only">{label}</span>
                </button>
              ))}
            </div>
          </div>
        </header>

        {viewMode === "timeline" ? (
          <StatusTimeline
            filters={getFilterOptions()}
            activeFilter={filter?.status || []}
            onFilterChange={onStatusFilterChange}
          />
        ) : (
          <FiltersCard
            filters={getFilterOptions()}
            activeFilter={filter?.status || []}
            onFilterChange={onStatusFilterChange}
          />
        )}

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
                          onCheckedChange={(checked) =>
                            handleCheckboxChange(checked as boolean, "all")
                          }
                        />
                      </div>
                    </TableHead>

                    {selection.length > 0 && (
                      <TableHead className="p-2" colSpan={isAllView ? 10 : 9}>
                        <div className="flex items-center gap-2 flex-wrap">
                          {/* Hidden on the five draft-stage cards: no row
                            there can have a label yet (buying one moves the
                            shipment out of "draft"), so the button would be
                            dead. Its slot is taken by the outcome dropdown
                            on the post-purchase cards. */}
                          {!isDraftStageView && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={
                                !compatibleTypeSelection(selection) ||
                                selectionHasDraft(selection) ||
                                documentPrinter.isLoading
                              }
                              className="px-3"
                              onClick={() =>
                                documentPrinter.openBatchLabels(selection, {
                                  format: (
                                    computeDocFormat(selection) || "pdf"
                                  )?.toLowerCase() as FormatType,
                                  doc: "label",
                                })
                              }
                            >
                              {documentPrinter.isLoading && (
                                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                              )}
                              Print Labels
                            </Button>
                          )}
                          {/* Shipped card onward: what the carrier reported is
                            not always what happened. Each option writes the
                            outcome (with its reason) to the ERP and then
                            moves the row to the matching Karrio card. */}
                          {isPostPurchaseView &&
                            isEnabled("btn_record_delivery_outcome") && (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={bulkAction !== null}
                                    className="px-3"
                                  >
                                    {bulkAction === "record_outcome" && (
                                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                    )}
                                    Record outcome
                                    <ChevronDown className="h-3 w-3 ml-1" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                  align="start"
                                  className="w-48"
                                >
                                  {OUTCOME_OPTIONS.map((option) => (
                                    <DropdownMenuItem
                                      key={option.outcome}
                                      onClick={() => selectOutcome(option)}
                                    >
                                      {option.label}
                                    </DropdownMenuItem>
                                  ))}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                          {/* Pick without printing: own delivery never buys a
                            label, and a carrier row may be picked before its
                            label run too. ERP bookkeeping only — the rows
                            move to the Picked card via the mirrored
                            erp_status. */}
                          {isTodayView && isEnabled("btn_mark_picked") && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={bulkAction !== null}
                              className="px-3"
                              onClick={runMarkPicked}
                            >
                              {bulkAction === "mark_picked" && (
                                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                              )}
                              Mark picked
                            </Button>
                          )}
                          {/* Today's warehouse run: opens the Pick & Print
                            popup over the selection. Picking, buying and
                            printing all happen in there, per SKU stack (see
                            buyPicklistShipments) — only offered on the Today
                            card, where the operator is working the printlist. */}
                          {isTodayView &&
                            isEnabled("btn_buy_label_dashboard") && (
                              <Button
                                variant="default"
                                size="sm"
                                disabled={
                                  bulkAction !== null ||
                                  documentPrinter.isLoading
                                }
                                className="px-3"
                                onClick={openPickAndPrint}
                              >
                                {bulkAction === "buy_and_print" && (
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                )}
                                Pick &amp; Print
                              </Button>
                            )}
                          {/* Picked card only: the parcel is with the carrier,
                            so the ERP row moves to In Transit. Own-delivery
                            rows in the selection are skipped by name. */}
                          {isPickedView && isEnabled("btn_mark_shipped") && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={bulkAction !== null}
                              className="px-3"
                              onClick={runMarkShipped}
                            >
                              {bulkAction === "mark_shipped" && (
                                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                              )}
                              Mark shipped
                            </Button>
                          )}
                          {/* Picked card, own delivery's departure. Creates the
                            Shopify fulfillment and notifies the customer, so
                            it is confirmed first (dialog at the bottom);
                            carrier rows in the selection are skipped by name. */}
                          {isPickedView &&
                            isEnabled("btn_mark_out_for_delivery") && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={bulkAction !== null}
                                className="px-3"
                                onClick={() => setOfdDialogOpen(true)}
                              >
                                {bulkAction === "mark_out_for_delivery" && (
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                )}
                                Mark out for delivery
                              </Button>
                            )}
                          {/* Draft cards only: hand the cancel to the ERP,
                            which cancels the Karrio draft itself and cleans
                            up behind it. Irreversible, so it is confirmed
                            first (see the dialog at the bottom). */}
                          {isDraftStageView &&
                            isEnabled("btn_cancel_shipment") && (
                              <Button
                                variant="destructive"
                                size="sm"
                                disabled={bulkAction !== null}
                                className="px-3"
                                onClick={() => setCancelDialogOpen(true)}
                              >
                                {bulkAction === "cancel_shipment" && (
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                )}
                                Cancel
                              </Button>
                            )}
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={documentPrinter.isLoading}
                            className="px-3"
                            onClick={() =>
                              documentPrinter.openBatchLabels(selection, {
                                format: "pdf",
                                doc: "invoice",
                              })
                            }
                          >
                            {documentPrinter.isLoading && (
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            )}
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
                                onClick={() =>
                                  documentPrinter.openTemplate(template.id, {
                                    shipments: selection.join(","),
                                  })
                                }
                              >
                                {documentPrinter.isLoading && (
                                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                )}
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
                        {isAllView && (
                          <TableHead className="status text-xs items-center">
                            STATUS
                          </TableHead>
                        )}
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
                        <TableHead className="date text-xs items-center">
                          DATE
                        </TableHead>
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
                          ? "bg-blue-50 hover:bg-blue-100"
                          : "hover:bg-gray-50"
                      }`}
                    >
                      {/* select-none: a shift+click range must not also drag
                        a text selection across the rows in between. */}
                      <TableCell className="selector text-center items-center p-0 sticky-left select-none">
                        <div className="py-3 pl-2 pr-4">
                          <Checkbox
                            checked={selection.includes(shipment.id)}
                            onCheckedChange={(checked) =>
                              handleCheckboxChange(
                                checked as boolean,
                                shipment.id,
                              )
                            }
                            onClick={(event) =>
                              handleSelectorClick(event, shipment.id)
                            }
                          />
                        </div>
                      </TableCell>
                      <TableCell
                        className="service items-center py-1 px-0 text-xs font-bold text-gray-600"
                        onClick={() => previewShipment(shipment.id)}
                        title={
                          routeLabel(shipment.metadata) ||
                          (isNone(getRate(shipment))
                            ? "UNFULFILLED"
                            : formatRef(
                                ((shipment.meta as any)?.service_name ||
                                  getRate(shipment).service) as string,
                              ))
                        }
                      >
                        <div className="flex items-center">
                          {/* Own delivery rides our own van: no carrier, so
                              instead of the letter-avatar fallback the row
                              shows the Bamboi panda. Same footprint (28px,
                              softly rounded like the avatar's rounded rect)
                              so the column stays aligned. */}
                          {isSelfDelivery(shipment.metadata) ? (
                            <div className="mt-1 ml-1 mr-2">
                              <img
                                src={p`/bamboi_icon.png`}
                                width={28}
                                height={28}
                                alt="Bamboi eigen bezorging"
                                className="rounded-sm"
                              />
                            </div>
                          ) : (
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
                          )}
                          {/* Colli count used to live in the status cell,
                              but that cell only renders on the All card now
                              — and multi-colli matters most while printing,
                              on exactly the cards without a status column. */}
                          {renderColli(shipment)}
                          <div
                            className="text-ellipsis"
                            style={{ maxWidth: "190px", lineHeight: "16px" }}
                          >
                            <span className="text-blue-600 font-bold">
                              {!isNone(shipment.tracking_number) && (
                                <span>{shipment.tracking_number}</span>
                              )}
                              {/* No tracking yet: the route takes the top
                                  line instead of a bare dash. */}
                              {isNone(shipment.tracking_number) && (
                                <span>
                                  {routeLabel(shipment.metadata) || " - "}
                                </span>
                              )}
                            </span>
                            <br />
                            <span className="text-ellipsis">
                              {/* The route renders exactly once: down here
                                  only when the tracking number holds the top
                                  line. MONTA FULFILLMENT/UNFULFILLED said
                                  nothing the route does not. */}
                              {routeLabel(shipment.metadata)
                                ? !isNone(shipment.tracking_number) &&
                                  routeLabel(shipment.metadata)
                                : !isNone(getRate(shipment).carrier_name)
                                  ? formatRef(
                                      ((getRate(shipment).meta as any)
                                        ?.service_name ||
                                        getRate(shipment).service) as string,
                                    )
                                  : "UNFULFILLED"}
                            </span>
                          </div>
                        </div>
                      </TableCell>
                      {isAllView && (
                        <TableCell
                          className="status items-center"
                          onClick={() => previewShipment(shipment.id)}
                        >
                          <div
                            className="flex items-center"
                            style={{ paddingLeft: "7px", paddingRight: "7px" }}
                          >
                            <ShipmentsStatusBadge
                              status={cardStatus(shipment)}
                              className="w-full justify-center text-center"
                            />
                          </div>
                        </TableCell>
                      )}
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
                            ]
                              .filter(Boolean)
                              .join(", ")}
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
                              {shipment.selected_rate.total_charge}{" "}
                              {shipment.selected_rate.currency}
                            </p>
                            {shipment.selected_rate.transit_days && (
                              <p className="text-gray-400 font-medium">
                                {shipment.selected_rate.transit_days}-
                                {shipment.selected_rate.transit_days + 2} days
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
                currentOffset={(filter.offset as number) || 0}
                pageSize={(filter.first as number) || pageSize}
                totalCount={shipments?.page_info?.count || 0}
                hasNextPage={shipments?.page_info?.has_next_page || false}
                onPageChange={(offset) => updateFilter({ offset })}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                onPageSizeChange={changePageSize}
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

        <ConfirmationDialog
          open={ofdDialogOpen}
          onOpenChange={setOfdDialogOpen}
          title="Mark out for delivery?"
          description={`De eigen-bezorgingsrijen in de selectie gaan de bus op: voor elk wordt de Shopify-fulfillment aangemaakt en de klant op de hoogte gebracht. Dit kan niet ongedaan gemaakt worden. Vervoerderszendingen in de selectie worden overgeslagen.`}
          confirmLabel="Mark out for delivery"
          cancelLabel="Terug"
          onConfirm={runMarkOutForDelivery}
          isLoading={bulkAction === "mark_out_for_delivery"}
        />

        <ConfirmationDialog
          open={cancelDialogOpen}
          onOpenChange={setCancelDialogOpen}
          title="Cancel shipment(s)?"
          description={`${selectedShipments().length} zending(en) worden geannuleerd in Karrio en in het ERP. Dit kan niet ongedaan gemaakt worden. Let op: de Sales Order zelf wordt NIET geannuleerd — alleen de zending.`}
          confirmLabel="Cancel shipment(s)"
          cancelLabel="Terug"
          onConfirm={runCancelShipments}
          isLoading={bulkAction === "cancel_shipment"}
        />

        <PicklistDialog
          open={picklistShipments !== null}
          onOpenChange={(open) => !open && setPicklistShipments(null)}
          shipments={picklistShipments || []}
          onBuyShipments={buyPicklistShipments}
          onAwaitPrinted={awaitPrinted}
          onConfirmAll={confirmPicklistRun}
          onOpenLabels={
            picklistPurchasedIds.length > 0
              ? () =>
                  documentPrinter.openBatchLabels(picklistPurchasedIds, {
                    // Format from the FROZEN rows, not the live page: the
                    // purchase moved these rows off the Today card, so
                    // computeDocFormat's page lookup would miss and default
                    // a ZPL batch to pdf exactly when the fallback matters.
                    format: (
                      picklistRowsRef.current.find(({ id }) =>
                        picklistPurchasedIds.includes(id),
                      )?.label_type || "pdf"
                    ).toLowerCase() as FormatType,
                    doc: "label",
                  })
              : null
          }
        />

        {/* Mounted only while an outcome is pending, so the reason field is
            empty again on every run. */}
        {outcomePrompt && (
          <ReasonPromptDialog
            open={true}
            onOpenChange={(open) => !open && setOutcomePrompt(null)}
            title={`Mark as ${outcomePrompt.label}`}
            description={`De reden wordt vastgelegd in het ERP voor ${selectedShipments().length} zending(en) en bepaalt hoe de rij verder wordt afgehandeld.`}
            fieldLabel="Reason"
            placeholder="bijv. pakket beschadigd retour ontvangen"
            confirmLabel={outcomePrompt.label}
            cancelLabel="Terug"
            onConfirm={(reason) => runRecordOutcome(outcomePrompt, reason)}
            isLoading={bulkAction === "record_outcome"}
          />
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
