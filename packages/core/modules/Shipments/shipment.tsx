"use client";
import { EnhancedMetadataEditor } from "@karrio/ui/components/enhanced-metadata-editor";
import { useMetadataMutation } from "@karrio/hooks/metadata";
import {
  useUploadRecordMutation,
  useUploadRecords,
} from "@karrio/hooks/upload-record";
import { AddressType, CustomsType, NotificationType, ParcelType, MetadataObjectTypeEnum, UpdateAddressInput } from "@karrio/types";
import { CustomsInfoDescription } from "@karrio/ui/components/customs-info-description";
import { ShipmentsStatusBadge } from "@karrio/ui/components/shipments-status-badge";
import { CommodityDescription } from "@karrio/ui/components/commodity-description";
import { AddressDescription } from "@karrio/ui/components/address-description";
import { AddressEditDialog } from "@karrio/ui/components/address-edit-dialog";
import {
  AddressValidationBadge,
  getAddressReview,
  getReplacement,
  isCorrected,
} from "@karrio/ui/components/address-validation-badge";
import { ShipmentPreviewSheetContext } from "@karrio/ui/components/shipment-preview-context";
import { useAppMode } from "@karrio/hooks/app-mode";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { ParcelDescription } from "@karrio/ui/components/parcel-description";
import { ActivityTimeline } from "@karrio/ui/components/activity-timeline";
import { useShipment, useShipmentMutation } from "@karrio/hooks/shipment";
import { CarrierImage } from "@karrio/ui/core/components/carrier-image";
import { RecentActivity } from "@karrio/ui/components/recent-activity";
import { CopiableLink } from "@karrio/ui/components/copiable-link";
import { ShipmentMenu } from "@karrio/ui/components/shipment-menu";
import { ReasonPromptDialog } from "@karrio/ui/components/reason-prompt-dialog";
import { useShipmentERPActions } from "@karrio/hooks/erp-actions";
import { useBamboiFeatures } from "@karrio/hooks/bamboi-features";
import { useNotifier } from "@karrio/ui/core/components/notifier";
import { formatDateTime, formatRef, isNone, p } from "@karrio/lib";
import { useLoader } from "@karrio/ui/core/components/loader";
import { AppLink } from "@karrio/ui/core/components/app-link";
import { DocumentUploadData } from "@karrio/types/rest/api";
import { useAPIMetadata } from "@karrio/hooks/api-metadata";
import { Button } from "@karrio/ui/components/ui/button";
import { Spinner } from "@karrio/ui/components/spinner";
import { useEvents } from "@karrio/hooks/event";
import { useLogs } from "@karrio/hooks/log";
import React from "react";

type FileDataType = DocumentUploadData["document_files"][0];

// Following the ERP after an address correction or confirm: how often the
// draft is re-read while the ERP validates, how long a voided draft is
// watched for the ERP's link to its replacement, and when "validating" starts
// to say it is slower than usual.
const FOLLOW_POLL_MS = 2_500;
const REPLACEMENT_WAIT_MS = 45_000;
const SLOW_VALIDATION_AFTER_MS = 45_000;

export const ShipmentComponent = ({
  shipmentId,
  isPreview,
  isSheet,
}: {
  shipmentId: string;
  isPreview?: boolean;
  isSheet?: boolean;
}): JSX.Element => {
  const notifier = useNotifier();
  const { setLoading } = useLoader();
  const $fileInput = React.useRef<HTMLInputElement>(null);
  const [selectValue, setSelectValue] = React.useState<string>("other");
  const {
    references: { carrier_capabilities = {} },
  } = useAPIMetadata();
  const entity_id = shipmentId;
  const { query: shipmentLogs } = useLogs({ entity_id });
  const { query: shipmentEvents } = useEvents({ entity_id });
  const [polling, setPolling] = React.useState(false);
  const {
    query: { data: { shipment } = {}, ...query },
  } = useShipment(entity_id, {
    refetchInterval: polling ? FOLLOW_POLL_MS : false,
  });
  const trackerId = shipment?.tracker_id;
  const cancelled = shipment?.status === "cancelled";
  // A cancelled draft has been replaced (the ERP rebuilds a review draft as a
  // NEW shipment once the address is corrected or confirmed); its stored
  // verdict describes an address nobody ships to anymore, so it is not shown.
  const addressReview = cancelled
    ? null
    : getAddressReview(shipment?.metadata, shipment?.meta);
  // The draft that took this one's place, once the ERP has linked it.
  const replacement = getReplacement(shipment?.metadata);
  const erpActions = useShipmentERPActions(entity_id);
  const { isEnabled } = useBamboiFeatures();
  const [confirmAddressOpen, setConfirmAddressOpen] = React.useState(false);

  // Where "open the rebuilt draft" leads: inside the preview sheet it swaps
  // the sheet to the new id (the URL's modal param follows); on the full
  // page it is a navigation.
  const router = useRouter();
  const { basePath } = useAppMode();
  const { previewShipment } = React.useContext(ShipmentPreviewSheetContext);
  const openShipment = (id: string) => {
    if (isPreview && typeof previewShipment === "function") {
      previewShipment(id);
    } else {
      router.push(p`${basePath}/shipments/${id}`);
    }
  };

  // Following the ERP. Set the moment this page has reason to expect the
  // draft to be replaced: a saved correction is being validated
  // (meta.address_sync_pending, which the ERP ends by voiding this draft and
  // building a new one), or a confirm came back without naming the new
  // draft. The draft is re-read every few seconds until the ERP's
  // replaced_by_shipment link shows up on it, and that draft is opened.
  const [followingSince, setFollowingSince] = React.useState<number | null>(
    null,
  );
  const [now, setNow] = React.useState(() => Date.now());
  const followedRef = React.useRef(false);
  React.useEffect(() => {
    // The same component instance can be handed the next id (the page
    // navigates to the rebuilt draft); the follow state belongs to the old one.
    setFollowingSince(null);
    followedRef.current = false;
  }, [entity_id]);
  const pending = Boolean(addressReview?.pending);
  React.useEffect(() => {
    if (pending && followingSince === null) setFollowingSince(Date.now());
  }, [pending, followingSince]);
  const waited =
    followingSince === null ? 0 : Math.max(0, now - followingSince);
  const awaitingReplacement =
    followingSince !== null &&
    cancelled &&
    !replacement &&
    waited < REPLACEMENT_WAIT_MS;
  const replacementLost =
    followingSince !== null &&
    cancelled &&
    !replacement &&
    waited >= REPLACEMENT_WAIT_MS;
  const following = pending || awaitingReplacement;
  React.useEffect(() => {
    setPolling(following);
    if (!following) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [following]);
  React.useEffect(() => {
    if (followingSince === null || !replacement || followedRef.current) return;
    followedRef.current = true;
    notifier.notify({
      type: NotificationType.success,
      message:
        "ERPNext validated the address and rebuilt the shipment. Opened the new draft.",
    });
    openShipment(replacement);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followingSince, replacement]);
  const { query: trackerLogs } = useLogs(trackerId ? { entity_id: trackerId } : { entity_id: "__none__" });
  const { query: trackerEvents } = useEvents(trackerId ? { entity_id: trackerId } : { entity_id: "__none__" });

  // Merge shipment and tracker logs/events for the activity timeline
  const logs = React.useMemo(() => {
    const shipmentEdges = shipmentLogs.data?.logs?.edges || [];
    const trackerEdges = trackerId ? (trackerLogs.data?.logs?.edges || []) : [];
    // Deduplicate by log id
    const seen = new Set<number | string>();
    const merged = [...shipmentEdges, ...trackerEdges].filter(({ node }) => {
      const key = node.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      isFetching: shipmentLogs.isFetching || (trackerId ? trackerLogs.isFetching : false),
      isFetched: shipmentLogs.isFetched,
      data: { logs: { edges: merged } },
    };
  }, [shipmentLogs, trackerLogs, trackerId]);

  const events = React.useMemo(() => {
    const shipmentEdges = shipmentEvents.data?.events?.edges || [];
    const trackerEdges = trackerId ? (trackerEvents.data?.events?.edges || []) : [];
    const seen = new Set<string>();
    const merged = [...shipmentEdges, ...trackerEdges].filter(({ node }) => {
      const key = node.id as string;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      isFetching: shipmentEvents.isFetching || (trackerId ? trackerEvents.isFetching : false),
      isFetched: shipmentEvents.isFetched,
      data: { events: { edges: merged } },
    };
  }, [shipmentEvents, trackerEvents, trackerId]);
  const { uploadDocument } = useUploadRecordMutation();
  const { updateShipment } = useShipmentMutation(entity_id);
  const { updateMetadata } = useMetadataMutation([
    "shipments",
    entity_id,
  ]);
  const {
    query: { data: { results: uploads } = {}, ...documents },
  } = useUploadRecords({ shipmentId: entity_id });
  const [fileData, setFileData] = React.useState<FileDataType>(
    {} as FileDataType,
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    try {
      if (!!e.target.files && !!e.target.files[0]) {
        let file = e.target.files[0];
        let reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onloadend = () => {
          let sections = (reader.result as string).split(",");
          let doc_file = sections[sections.length - 1];
          let doc_name = file.name;
          setFileData({ ...fileData, doc_name, doc_file });
        };
      } else {
        setFileData({ doc_file: fileData.doc_file } as FileDataType);
      }
    } catch (_) {
      setFileData({ doc_file: fileData.doc_file } as FileDataType);
    }
  };
  const uploadCustomsDocument = async () => {
    try {
      await uploadDocument.mutateAsync({
        shipment_id: entity_id,
        document_files: [fileData],
      });
      notifier.notify({
        type: NotificationType.success,
        message: `document updloaded successfully`,
      });
      if (!!$fileInput.current) $fileInput.current.value = "";
      setSelectValue("other");
    } catch (message: any) {
      notifier.notify({ type: NotificationType.error, message });
    }
  };

  const correctRecipientAddress = async (address: AddressType) => {
    try {
      const recipientId = address.id || shipment?.recipient?.id;
      if (!recipientId) {
        throw new Error("The shipment recipient address could not be resolved.");
      }

      await updateShipment.mutateAsync({
        id: entity_id,
        recipient: { ...address, id: recipientId } as UpdateAddressInput,
      });
      notifier.notify({
        type: NotificationType.success,
        message:
          "Address saved. ERPNext is validating it now; this page opens the rebuilt shipment when it is ready.",
      });
    } catch (message: any) {
      notifier.notify({ type: NotificationType.error, message });
      throw message;
    }
  };

  // Rico's override of Google's hint: relayed to the ERP's own Confirm-as-
  // correct door, so the server re-validates and only a Suspect verdict
  // passes — the button is a courtesy, not the boundary.
  const confirmAddressCorrect = async (reason: string) => {
    try {
      const { message, shipment_id } =
        await erpActions.confirmAddress.mutateAsync({
          id: entity_id,
          reason,
        });
      setConfirmAddressOpen(false);
      if (shipment_id && shipment_id !== entity_id) {
        // The ERP released the order and rebuilt the draft before answering;
        // the one on screen is cancelled. Go where the work is.
        notifier.notify({
          type: NotificationType.success,
          message: `${message} Opened the rebuilt shipment.`,
        });
        openShipment(shipment_id);
        return;
      }
      notifier.notify({ type: NotificationType.success, message });
      // An ERP that did not name the rebuilt draft: watch this one for the
      // replacement link instead.
      setFollowingSince(Date.now());
    } catch (message: any) {
      notifier.notify({ type: NotificationType.error, message });
      // Rethrown so the reason dialog stays open, reason in place, for a retry.
      throw message;
    }
  };

  const handleMetadataChange = async (newMetadata: any) => {
    try {
      const currentMetadata = shipment?.metadata || {};

      // Calculate added_values (new or changed metadata)
      const added_values = { ...newMetadata };

      // Calculate discarded_keys (keys that were removed)
      const discarded_keys = Object.keys(currentMetadata).filter(
        key => !(key in newMetadata)
      );

      await updateMetadata.mutateAsync({
        id: entity_id,
        object_type: MetadataObjectTypeEnum.shipment,
        discarded_keys,
        added_values,
      });

      notifier.notify({
        type: NotificationType.success,
        message: "Metadata updated successfully",
      });
    } catch (error) {
      notifier.notify({
        type: NotificationType.error,
        message: "Failed to update metadata",
      });
    }
  };

  React.useEffect(() => {
    setLoading(query.isFetching);
  }, [query.isFetching]);

  return (
    <>
      {!query.isFetched && query.isFetching && <Spinner />}

      {shipment && (
        <div className="space-y-4">
          {/* Header Section - Full Width */}
          <div className="flex justify-between items-start gap-4">
            <div className="space-y-2 flex-1">
              <AppLink
                href="/shipments"
                className="text-sm font-semibold text-blue-600 tracking-wide hover:text-blue-800 transition-colors duration-150 flex items-center gap-1"
              >
                Shipments <i className="fas fa-chevron-right text-xs"></i>
              </AppLink>
              <div className="flex items-center gap-2">
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-bold">
                    {shipment.selected_rate?.total_charge !== undefined && shipment.selected_rate?.total_charge !== null
                      ? Number(shipment.selected_rate.total_charge).toFixed(2)
                      : (shipment.status === "created" ? "0.00"
                        : shipment.status === "draft" ? "DRAFT"
                          : "UNFULFILLED")}
                  </span>
                  {shipment.selected_rate?.currency && (
                    <span className="text-3xl text-gray-600">
                      {shipment.selected_rate?.currency}
                    </span>
                  )}
                </div>
                <ShipmentsStatusBadge status={shipment.status} />
              </div>

              {/* Mobile ShipmentMenu - positioned after cost/currency line */}
              <div className={`flex justify-start items-center gap-1 md:hidden`}>
                {isPreview && isSheet && (
                  <Button
                    variant="ghost"
                    size="sm"
                    asChild
                    className="h-8"
                  >
                    <AppLink
                      href={`/shipments/${shipmentId}`}
                      target="_blank"
                    >
                      <i className="fas fa-external-link-alt text-xs"></i>
                    </AppLink>
                  </Button>
                )}
                <ShipmentMenu shipment={shipment as any} isViewing variant="outline" />
              </div>
            </div>

            {/* Desktop ShipmentMenu - positioned in top-right corner */}
            <div className={`${isSheet ? 'hidden md:flex' : 'hidden md:flex'} items-center gap-1`}>
              {isPreview && (
                <Button
                  variant="ghost"
                  size="sm"
                  asChild
                  className="h-8"
                >
                  <AppLink
                    href={`/shipments/${shipmentId}`}
                    target="_blank"
                  >
                    <i className="fas fa-external-link-alt text-xs"></i>
                  </AppLink>
                </Button>
              )}
              <ShipmentMenu shipment={shipment as any} isViewing variant="outline" />
            </div>
          </div>


          {/* Main Content with Sidebar Layout */}
          <div className={`flex flex-col ${isSheet ? '' : 'lg:grid lg:grid-cols-4'} gap-6`}>
            {/* Right Sidebar - Details Section */}
            {!isNone(shipment.selected_rate) && (
              <div className={isSheet ? '' : 'lg:order-2 lg:col-span-1 lg:col-start-4'}>
                <h3 className={`text-xl font-semibold my-4 ${isSheet ? '' : 'lg:mb-4 lg:mt-0'}`}>
                  Details
                </h3>
                <div className={isSheet ? 'grid grid-cols-1 md:grid-cols-2 gap-4' : 'space-y-3'}>
                  <div className="space-y-3">
                    <div>
                      <div className="text-xs mb-1 font-bold">Shipment ID</div>
                      <CopiableLink text={shipment.id as string} title="Copy ID" variant="outline" />
                    </div>
                    {trackerId && (
                      <div>
                        <div className="text-xs mb-1 font-bold">Tracker ID</div>
                        <CopiableLink text={trackerId} title="Copy Tracker ID" variant="outline" />
                      </div>
                    )}
                    <div>
                      <div className="text-xs mb-1 font-bold">Shipment method</div>
                      <div className="flex items-center">
                        <CarrierImage
                          carrier_name={(shipment.meta.custom_carrier_name || shipment.meta.carrier) as string}
                          containerClassName="mt-1 ml-1 mr-2"
                          height={28}
                          width={28}
                          text_color={(shipment.selected_rate_carrier as any)?.config?.text_color}
                          background={(shipment.selected_rate_carrier as any)?.config?.brand_color}
                        />
                        <div className="text-ellipsis text-xs" style={{ maxWidth: "190px", lineHeight: "16px" }}>
                          <span className="text-blue-600 font-bold">
                            {!isNone(shipment.tracking_number) && (
                              <span>{shipment.tracking_number}</span>
                            )}
                            {isNone(shipment.tracking_number) && (
                              <span>-</span>
                            )}
                          </span>
                          <br />
                          <span className="text-ellipsis">
                            {formatRef(
                              ((shipment.meta as any)?.service_name ||
                                shipment.service) as string,
                            )}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div>
                      <div className="text-xs mb-1 font-bold">Service Level</div>
                      <div className="text-sm font-medium">
                        {formatRef(
                          ((shipment.meta as any)?.service_name ||
                            shipment.service) as string,
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs mb-1 font-bold">Rate Provider</div>
                      <div className="text-sm text-blue-600 font-medium">
                        {formatRef(shipment.meta.ext as string)}
                      </div>
                    </div>
                    {!isNone(shipment.reference) && (
                      <div>
                        <div className="text-xs mb-1 font-bold">Reference</div>
                        <div className="text-sm font-medium">
                          {shipment.reference}
                        </div>
                      </div>
                    )}
                    {(shipment as any).request_id && (
                      <div>
                        <div className="text-xs mb-1 font-bold">Request ID</div>
                        <CopiableLink text={(shipment as any).request_id} title="Copy Request ID" variant="outline" />
                      </div>
                    )}
                  </div>
                  <div className="space-y-3">
                    <div>
                      <div className="text-xs mb-1 font-bold">Tracking Number</div>
                      <div className="text-sm font-medium text-blue-600">
                        {shipment.tracking_number as string}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs mb-1 font-bold">Ship At</div>
                      <div className="text-sm font-medium">
                        {formatDateTime(shipment.options.shipping_date)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs mb-1 font-bold">Created At</div>
                      <div className="text-sm font-medium">
                        {formatDateTime(shipment.created_at)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs mb-1 font-bold">Last update</div>
                      <div className="text-sm">{formatDateTime(shipment.updated_at)}</div>
                    </div>
                  </div>
                </div>

                {/* Metadata Section - Part of sidebar on desktop only */}
                <div className={isSheet ? "hidden" : "hidden lg:block mt-6"}>
                  <h4 className="text-xl font-semibold mb-3">Metadata</h4>
                  <EnhancedMetadataEditor
                    value={shipment.metadata || {}}
                    onChange={handleMetadataChange}
                    placeholder="No metadata configured"
                    emptyStateMessage="Add key-value pairs to configure metadata"
                    allowEdit={true}
                    showTypeInference={true}
                    maxHeight="300px"
                  />
                </div>
              </div>
            )}

            {/* Left Column - Main Content */}
            <div className={`space-y-6 order-1 mr-5 ${isSheet ? '' : 'lg:col-span-3 lg:col-start-1 lg:order-1'}`}>

              {!isNone(shipment.tracker) && (
                <>
                  <div className="flex justify-between items-center my-4">
                    <h2 className="text-xl font-semibold">Recent Activity</h2>
                    <a
                      className="text-xs text-blue-600 hover:text-blue-800 font-semibold flex items-center gap-1"
                      href={`/tracking/${shipment.tracker_id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Tracking details
                      <i className="fas fa-external-link-alt text-xs"></i>
                    </a>
                  </div>
                  <hr className="mt-1 mb-2" style={{ height: "1px" }} />
                  <div className="mt-3 mb-6">
                    <RecentActivity
                      tracker={shipment.tracker}
                    />
                  </div>
                </>
              )}

              {/* Charges section */}
              {!isNone(shipment.selected_rate) &&
                (shipment.selected_rate?.extra_charges || []).length > 0 && (
                  <>
                    <h2 className="text-xl font-semibold my-4">Charges breakdown</h2>

                    <div className="mt-1 mb-6">
                      <div className="space-y-2">
                        {/* Extra charges items */}
                        {(shipment.selected_rate?.extra_charges || []).map(
                          (charge, index) => (
                            <div key={index}>
                              <div className="flex justify-between items-center">
                                <span className="text-sm text-gray-900">
                                  {charge?.name || 'Charge'}
                                </span>
                                <div className="text-sm text-gray-900 text-right">
                                  <span className="mr-1">{charge?.amount}</span>
                                  {!isNone(charge?.currency) && (
                                    <span>{charge?.currency}</span>
                                  )}
                                </div>
                              </div>
                              {index < (shipment.selected_rate?.extra_charges || []).length - 1 && (
                                <hr className="border-gray-200 mt-2" style={{ height: "1px" }} />
                              )}
                            </div>
                          )
                        )}

                        {/* Separator before total */}
                        {(shipment.selected_rate?.extra_charges || []).length > 0 && (
                          <hr className="border-gray-200" style={{ height: "1px" }} />
                        )}

                        {/* Total line */}
                        <div className="flex justify-between items-center">
                          <span className="text-sm font-semibold text-gray-900">
                            Total
                          </span>
                          <div className="text-sm font-semibold text-gray-900 text-right">
                            <span className="mr-1">
                              {Number(shipment.selected_rate?.total_charge).toFixed(2)}
                            </span>
                            {shipment.selected_rate?.currency && (
                              <span>{shipment.selected_rate?.currency}</span>
                            )}
                          </div>
                        </div>

                        {/* Line below total */}
                        <hr className="border-gray-200 mt-1" style={{ height: "1px" }} />
                      </div>
                    </div>
                  </>
                )}

              {/* Connection details section */}
              {(shipment.selected_rate_carrier?.connection_id ||
                shipment.selected_rate_carrier?.carrier_id ||
                shipment.selected_rate_carrier?.carrier_name) && (
                  <>
                    <h2 className="text-xl font-semibold my-4">Connection Details</h2>
                    <hr className="mt-1 mb-2" style={{ height: "1px" }} />

                    <div className="mt-3 mb-6">
                      <div className={`grid grid-cols-1 ${isSheet ? '' : 'md:grid-cols-2'} gap-6 my-0`}>
                        <div className="space-y-2">
                          {/* Connection ID */}
                          <div className="flex flex-col xl:flex-row xl:items-center">
                            <div className="text-xs font-bold xl:w-32 mb-1 xl:mb-0">Connection ID</div>
                            <div className="text-sm font-medium break-all">
                              {shipment.selected_rate_carrier?.connection_id || '-'}
                            </div>
                          </div>

                          {/* Carrier ID */}
                          <div className="flex flex-col xl:flex-row xl:items-center">
                            <div className="text-xs font-bold xl:w-32 mb-1 xl:mb-0">Carrier ID</div>
                            <div className="text-sm font-medium break-all">
                              {shipment.selected_rate_carrier?.carrier_id || '-'}
                            </div>
                          </div>

                          {/* Type */}
                          <div className="flex flex-col xl:flex-row xl:items-center">
                            <div className="text-xs font-bold xl:w-32 mb-1 xl:mb-0">Type</div>
                            <div className="text-sm font-medium break-all">
                              {shipment.selected_rate_carrier?.carrier_name || '-'}
                            </div>
                          </div>

                          {/* Provider */}
                          <div className="flex flex-col xl:flex-row xl:items-center">
                            <div className="text-xs font-bold xl:w-32 mb-1 xl:mb-0">Provider</div>
                            <div className="text-sm font-medium break-all">
                              {shipment.selected_rate_carrier?.carrier_code || '-'}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                )}

              {/* Return Shipment section */}
              {!isNone(shipment.return_shipment) && (
                <>
                  <h2 className="text-xl font-semibold my-4">Return Shipment</h2>
                  <hr className="mt-1 mb-2" style={{ height: "1px" }} />

                  <div className="mt-3 mb-6">
                    <div className={`grid grid-cols-1 ${isSheet ? '' : 'md:grid-cols-2'} gap-6 my-0`}>
                      <div className="space-y-2">
                        {shipment.return_shipment?.tracking_number && (
                          <div className="flex flex-col xl:flex-row xl:items-center">
                            <div className="text-xs font-bold xl:w-36 mb-1 xl:mb-0">Tracking Number</div>
                            <div className="text-sm font-medium break-all">
                              {shipment.return_shipment.tracking_url ? (
                                <a
                                  href={shipment.return_shipment.tracking_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 hover:underline"
                                >
                                  {shipment.return_shipment.tracking_number}
                                </a>
                              ) : (
                                shipment.return_shipment.tracking_number
                              )}
                            </div>
                          </div>
                        )}

                        {shipment.return_shipment?.shipment_identifier && (
                          <div className="flex flex-col xl:flex-row xl:items-center">
                            <div className="text-xs font-bold xl:w-36 mb-1 xl:mb-0">Shipment ID</div>
                            <div className="text-sm font-medium break-all">
                              {shipment.return_shipment.shipment_identifier}
                            </div>
                          </div>
                        )}

                        {shipment.return_shipment?.service && (
                          <div className="flex flex-col xl:flex-row xl:items-center">
                            <div className="text-xs font-bold xl:w-36 mb-1 xl:mb-0">Service</div>
                            <div className="text-sm font-medium break-all">
                              {shipment.return_shipment.service}
                            </div>
                          </div>
                        )}

                        {shipment.return_shipment?.reference && (
                          <div className="flex flex-col xl:flex-row xl:items-center">
                            <div className="text-xs font-bold xl:w-36 mb-1 xl:mb-0">Reference</div>
                            <div className="text-sm font-medium break-all">
                              {shipment.return_shipment.reference}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Summary section */}
              <h2 className="text-xl font-semibold my-4">Summary</h2>
              <hr className="mt-1 mb-2" style={{ height: "1px" }} />

              <div className="mt-3 mb-6">
                <div className="space-y-3">
                  {/* Shipping To section */}
                  <div className="text-base py-1">
                    <div className="flex items-center justify-between gap-3 my-2">
                      <div className="flex items-center gap-2">
                        <p className="text-base font-semibold tracking-wide">
                          Shipped To
                        </p>
                        {addressReview && (
                          <AddressValidationBadge
                            status={addressReview.status}
                            title={addressReview.note || ""}
                          />
                        )}
                      </div>
                      {/* Overrule Google's hint: only offered on a Suspect
                          verdict — Invalid has no confirm door, by design,
                          and the ERP refuses it server-side regardless. */}
                      {shipment.status === "draft" &&
                        Boolean(shipment.metadata?.sales_order) &&
                        addressReview?.status === "Suspect" &&
                        !addressReview?.pending &&
                        isEnabled("btn_confirm_address") && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setConfirmAddressOpen(true)}
                            disabled={erpActions.confirmAddress.isLoading}
                          >
                            {erpActions.confirmAddress.isLoading ? (
                              <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                            ) : (
                              <i className="fas fa-check mr-2 text-xs"></i>
                            )}
                            {erpActions.confirmAddress.isLoading
                              ? "Confirming…"
                              : "Address is correct"}
                          </Button>
                        )}
                      {shipment.status === "draft" && Boolean(shipment.metadata?.sales_order) && (
                        <AddressEditDialog
                          header="Correct delivery address"
                          description="The delivery location and phone will be validated in ERPNext, synchronized to Shopify, and only then released to the carrier."
                          mode="delivery"
                          shipment={shipment as any}
                          address={shipment.recipient}
                          onSubmit={correctRecipientAddress}
                          trigger={
                            <Button variant="outline" size="sm">
                              <i className="fas fa-pen mr-2 text-xs"></i>
                              Correct address
                            </Button>
                          }
                        />
                      )}
                    </div>

                    <ReasonPromptDialog
                      open={confirmAddressOpen}
                      onOpenChange={setConfirmAddressOpen}
                      title="Address is correct"
                      description="Overrules Google's hint for every order shipping to this address. Say how you verified it — the reason goes on the record. ERPNext re-checks the verdict, releases the order and rebuilds this shipment; you are taken to the new draft."
                      fieldLabel="How was this address verified?"
                      placeholder="e.g. called the customer, checked with the neighbour"
                      confirmLabel="Confirm address"
                      processingLabel="Confirming in ERPNext…"
                      onConfirm={confirmAddressCorrect}
                      isLoading={erpActions.confirmAddress.isLoading}
                    />

                    <AddressDescription address={shipment.recipient} />

                    {addressReview?.pending && (
                      <div className="mt-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
                        <p className="flex items-center gap-2 font-semibold">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Validating the corrected address in ERPNext
                        </p>
                        <p className="mt-1 text-xs text-blue-800">
                          ERPNext saves the address, has Google re-check it,
                          pushes it to Shopify and rebuilds this shipment. This
                          page opens the rebuilt draft as soon as it exists.
                        </p>
                        <p className="mt-1 text-xs text-blue-700">
                          {waited < SLOW_VALIDATION_AFTER_MS
                            ? `Checking every few seconds · ${Math.round(waited / 1000)}s`
                            : "Taking longer than usual — ERPNext may be busy. This keeps checking; the ERP shipment's timeline says what it is doing."}
                        </p>
                      </div>
                    )}

                    {awaitingReplacement && (
                      <div className="mt-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
                        <p className="flex items-center gap-2 font-semibold">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Address accepted — ERPNext is rebuilding the shipment
                        </p>
                        <p className="mt-1 text-xs text-blue-800">
                          This draft was voided; the rebuilt one opens here in
                          a moment.
                        </p>
                      </div>
                    )}

                    {cancelled && replacement && (
                      <div className="mt-2 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm">
                        <p className="font-semibold text-green-800">
                          Replaced after an address correction
                        </p>
                        <p className="mt-1 text-xs text-green-700">
                          ERPNext voided this draft and rebuilt the order as a
                          new shipment.
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          onClick={() => openShipment(replacement)}
                        >
                          Open the current shipment
                          <i className="fas fa-arrow-right ml-2 text-xs"></i>
                        </Button>
                      </div>
                    )}

                    {replacementLost && (
                      <div className="mt-2 rounded border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm">
                        <p className="font-semibold text-yellow-800">
                          This draft was voided, but the rebuilt shipment was
                          not linked
                        </p>
                        <p className="mt-1 text-xs text-yellow-800">
                          ERPNext cancelled this draft after the correction.
                          Look the order up in the shipment list
                          {shipment.metadata?.sales_order
                            ? ` (${shipment.metadata.sales_order})`
                            : ""}
                          , or check the ERP shipment's timeline.
                        </p>
                        <AppLink
                          href="/shipments"
                          className="mt-2 inline-block text-xs font-semibold text-yellow-900 underline"
                        >
                          Open the shipment list
                        </AppLink>
                      </div>
                    )}

                    {addressReview?.error && (
                      <div className="mt-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm">
                        <p className="font-semibold text-red-800">
                          ERPNext could not apply the last correction
                        </p>
                        <p className="mt-1 text-xs text-red-700 whitespace-pre-line">
                          {addressReview.error}
                        </p>
                        <p className="mt-1 text-xs text-red-700">
                          The verdict shown is for the address as ERPNext still
                          has it. Correct the address again, or fix it in
                          ERPNext.
                        </p>
                      </div>
                    )}

                    {addressReview && isCorrected(addressReview.status) && (
                      <div className="mt-2 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm">
                        <p className="font-semibold text-green-800">
                          Address corrected
                        </p>
                        {addressReview.note && (
                          <p className="text-xs text-green-700 mt-1 whitespace-pre-line">
                            {addressReview.note}
                          </p>
                        )}
                      </div>
                    )}

                    {addressReview?.suggestion && (
                      <div className="mt-2 rounded border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm">
                        <p className="font-semibold text-yellow-800">
                          Google suggests
                        </p>
                        <p className="text-yellow-900">
                          {addressReview.suggestion}
                        </p>
                        {addressReview.note && (
                          <p className="text-xs text-yellow-700 mt-1">
                            {addressReview.note}
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Shipped From section */}
                  {!isNone(shipment.shipper) && (
                    <div className="text-base py-1">
                      <p className="text-base font-semibold tracking-wide my-2">
                        Shipped From
                      </p>

                      <AddressDescription address={shipment.shipper} />
                    </div>
                  )}
                </div>
              </div>

              {/* Parcels section */}
              <h2 className="text-xl font-semibold my-4">Parcels</h2>
              <hr className="mt-1 mb-2" style={{ height: "1px" }} />

              <div className="mt-3 mb-6">
                {shipment.parcels.map((parcel: ParcelType, index) => (
                  <React.Fragment key={index + "parcel-info"}>
                    {index > 0 && <hr className="my-4" style={{ height: "1px" }} />}

                    <div className={`grid grid-cols-1 ${isSheet ? '' : 'md:grid-cols-2'} gap-6 mb-0`}>
                      {/* Parcel details */}
                      <div className="text-base py-1">
                        <ParcelDescription parcel={parcel} />
                      </div>

                      {/* Parcel items */}
                      {(parcel.items || []).length > 0 && (
                        <div className="text-base py-1">
                          <p className="text-base font-semibold uppercase tracking-wide my-2">
                            ITEMS{" "}
                            <span className="text-xs">
                              (
                              {(parcel.items || []).reduce(
                                (acc, { quantity }) => acc + (quantity || 0),
                                0,
                              )}
                              )
                            </span>
                          </p>

                          <div
                            className="py-2 pr-1 max-h-[40rem] overflow-auto"
                          >
                            {(parcel.items || []).map((item, index) => (
                              <React.Fragment key={index + "item-info"}>
                                <hr
                                  className="mt-1 mb-2"
                                  style={{ height: "1px" }}
                                />
                                <CommodityDescription commodity={item} />
                              </React.Fragment>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </React.Fragment>
                ))}
              </div>

              {/* Customs Declaration section */}
              {!isNone(shipment.customs) && (
                <>
                  <h2 className="text-xl font-semibold my-4">Customs Declaration</h2>
                  <hr className="mt-1 mb-2" style={{ height: "1px" }} />

                  <div className="mt-3 mb-6">
                    <div className="text-base py-1">
                      <CustomsInfoDescription
                        customs={shipment.customs as CustomsType}
                      />
                    </div>
                  </div>
                </>
              )}

              {/* Commodities section */}
              {!isNone(shipment.customs) &&
                (shipment.customs?.commodities || []).length > 0 && (
                  <>
                    <h2 className="text-xl font-semibold my-4">
                      Commodities{" "}
                      <span className="text-lg">
                        (
                        {(shipment.customs?.commodities || []).reduce(
                          (acc, { quantity }) => acc + (quantity || 0),
                          0,
                        )}
                        )
                      </span>
                    </h2>
                    <hr className="mt-1 mb-2" style={{ height: "1px" }} />

                    <div className="mt-3 mb-6">
                      {(shipment.customs?.commodities || []).map(
                        (commodity, index) => (
                          <React.Fragment key={index + "parcel-info"}>
                            {index > 0 && <hr className="mt-1 mb-2" style={{ height: "1px" }} />}
                            <CommodityDescription commodity={commodity} />
                          </React.Fragment>
                        ),
                      )}
                    </div>
                  </>
                )}

              {/* Metadata Section - Mobile only, positioned before timeline */}
              <div className={isSheet ? "" : "lg:hidden"}>
                <h2 className="text-xl font-semibold my-4">Metadata</h2>
                <hr className="mt-1 mb-2" style={{ height: "1px" }} />

                <div className="my-4">
                  <EnhancedMetadataEditor
                    value={shipment.metadata || {}}
                    onChange={handleMetadataChange}
                    placeholder="No metadata configured"
                    emptyStateMessage="Add key-value pairs to configure metadata"
                    allowEdit={true}
                    showTypeInference={true}
                    maxHeight="300px"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Activity Timeline section */}
          <h2 className="text-xl font-semibold my-4">Activity</h2>
          <ActivityTimeline
            logs={logs}
            events={events}
          />

        </div>
      )}

      {query.isFetched && isNone(shipment) && (
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm my-6">
          <div className="p-6 text-center">
            <p>Uh Oh!</p>
            <p>{"We couldn't find any shipment with that reference"}</p>
          </div>
        </div>
      )}
    </>
  );
};

export default function Page(pageProps: { params: Promise<{ id?: string }> }) {
  const Component = (): JSX.Element => {
    const params = React.use(pageProps.params);
    const { id } = params;

    if (!id) return <></>;

    return <ShipmentComponent shipmentId={id} />;
  };

  return <Component />;
}
