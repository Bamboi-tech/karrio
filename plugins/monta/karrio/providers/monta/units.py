import re
import karrio.lib as lib
import karrio.core.units as units


class ConnectionConfig(lib.Enum):
    """Carrier connection configuration options."""

    origin = lib.OptionEnum("origin", str)
    shipper_code = lib.OptionEnum("shipper_code", str)
    allowed_shippers = lib.OptionEnum("allowed_shippers", list)
    include_return_labels = lib.OptionEnum("include_return_labels", bool, True)
    label_file_type = lib.OptionEnum("label_file_type", str, "PDF")
    shipping_options = lib.OptionEnum("shipping_options", list)
    shipping_services = lib.OptionEnum("shipping_services", list)


class PackagingType(lib.StrEnum):
    """Carrier specific packaging type"""

    PACKAGE = "PACKAGE"

    """ Unified Packaging type mapping """
    envelope = PACKAGE
    pak = PACKAGE
    tube = PACKAGE
    pallet = PACKAGE
    small_box = PACKAGE
    medium_box = PACKAGE
    your_packaging = PACKAGE


class ShippingService(lib.StrEnum):
    """Carrier specific services.

    Monta is a fulfillment provider: it selects the actual carrier (DHL, DPD,
    PostNL, ...) based on the shipping agreements configured in the Monta
    portal. Karrio therefore exposes a single flat service.
    """

    monta_fulfillment = "Monta Fulfillment"


class ShippingOption(lib.Enum):
    """Carrier specific options"""

    monta_origin = lib.OptionEnum("origin", str)
    monta_shipper_code = lib.OptionEnum("shipper_code", str)
    monta_allowed_shippers = lib.OptionEnum("allowed_shippers", list)
    monta_webshop_order_id = lib.OptionEnum("webshop_order_id", str)
    monta_planned_shipment_date = lib.OptionEnum("planned_shipment_date", str)
    monta_delivery_date_requested = lib.OptionEnum("delivery_date_requested", str)
    monta_shipping_comment = lib.OptionEnum("shipping_comment", str)
    monta_comment = lib.OptionEnum("comment", str)
    monta_b2b = lib.OptionEnum("b2b", bool)
    monta_include_return_labels = lib.OptionEnum("include_return_labels", bool)


def shipping_options_initializer(
    options: dict,
    package_options: units.ShippingOptions = None,
) -> units.ShippingOptions:
    """
    Apply default values to the given options.
    """

    if package_options is not None:
        options.update(package_options.content)

    def items_filter(key: str) -> bool:
        return key in ShippingOption  # type: ignore

    return units.ShippingOptions(options, ShippingOption, items_filter=items_filter)


class TrackingStatus(lib.Enum):
    """Maps Monta order event TypeCodes and collo DeliveryStatusCodes to
    normalized Karrio statuses.

    Monta does not publish a closed enum for these codes, so matching is done
    on normalized keywords (see `to_tracking_status`). Declaration order
    matters: more specific statuses must come before broader keywords
    (e.g. RETURNEDTOSENDER before DELIVERED).
    """

    cancelled = ["CANCELLED", "CANCELED", "DELETED", "ANNULEERD"]
    return_to_sender = ["RETURNTOSENDER", "RETURNEDTOSENDER", "RETURNED", "RETOUR", "RMA"]
    delivery_failed = [
        "DELIVERYFAILED",
        "DELIVERYFAILURE",
        "FAILEDDELIVERY",
        "NOTDELIVERED",
        "REFUSED",
        "MANCO",
        "LOST",
    ]
    delivery_delayed = ["DELAYED", "DELAY", "VERTRAAGD"]
    out_for_delivery = ["OUTFORDELIVERY", "WITHDRIVER", "INBEZORGING"]
    ready_for_pickup = ["READYFORPICKUP", "PICKUPPOINT", "ATPICKUPPOINT", "AFHAALPUNT"]
    on_hold = ["ONHOLD", "BLOCKED", "QUARANTAINE", "ADDRESSISSUE", "HOLD"]
    delivered = ["DELIVERED", "AFGELEVERD", "BEZORGD", "POD"]
    in_transit = [
        "SHIPPED",
        "INTRANSIT",
        "TRANSIT",
        "SORTING",
        "SORTED",
        "ENROUTE",
        "ONDERWEG",
        "HANDEDTOCARRIER",
        "ATCARRIER",
        "DEPARTED",
        "ARRIVED",
    ]
    picked_up = ["PICKED", "PACKED", "LABELCREATED", "LABELPRINTED", "PICKING", "INPICKING"]
    pending = ["RECEIVED", "VERIFIED", "OPEN", "NEW", "BACKORDER", "CREATED", "PENDING"]


def to_tracking_status(*codes: str) -> str:
    """Resolve the first matching normalized Karrio status for the given
    Monta event/delivery status codes or descriptions."""
    normalized = [_normalize(code) for code in codes if code]

    for status in list(TrackingStatus):
        keywords = [_normalize(keyword) for keyword in status.value]

        if any(
            value == keyword or keyword in value
            for value in normalized
            for keyword in keywords
        ):
            return status.name

    return "unknown"


def _normalize(value: str) -> str:
    return re.sub(r"[^A-Z]", "", str(value).upper())
