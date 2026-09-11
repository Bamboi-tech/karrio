"""Karrio Monta tracking API implementation.

Karrio trackers for Monta shipments are keyed by the Monta WebshopOrderId
(== the shipment's tracking_number). For each tracker the proxy fetches:

- `GET /order/{id}/events`  -> order event history (received, picked, shipped...)
- `GET /order/{id}/colli`   -> per-box carrier delivery status + T&T codes

Both sources are merged into one normalized Karrio event stream. The overall
status is taken from the collo carrier statuses when available (these reflect
the actual DHL/DPD/PostNL delivery state), falling back to the latest order
event.

Timestamps: Monta writes wall-clock time in Europe/Amsterdam without an
offset — ISO-ish on the order/events feed (`2026-09-10T15:41:14.147`) and
Dutch day-first on the collo summary (`11-9-2026 16:22:39`, no zero padding).
Every timestamp is parsed here, localized and emitted as UTC, so a Shipped at
15:41 Amsterdam lands as 13:41Z instead of 15:41Z (seen live on 2026-09-11: the
customer page showed every Monta step two hours late). A value that fits no
known format yields no timestamp rather than an exception: one order with an
odd date must never take the whole tracking batch down with it (the first
collo carrying a carrier status did exactly that on 2026-09-10 — 164 crashed
batches, every Monta tracker frozen for a day).
"""

import karrio.schemas.monta.order_event_response as monta
import karrio.schemas.monta.collo_response as collo_schema

import typing
import datetime
import zoneinfo
import karrio.lib as lib
import karrio.core.models as models
import karrio.providers.monta.error as error
import karrio.providers.monta.utils as provider_utils
import karrio.providers.monta.units as provider_units

DATETIME_FORMATS = [
    "%Y-%m-%dT%H:%M:%S.%f%z",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S.%fZ",
    "%Y-%m-%dT%H:%M:%SZ",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S",
    # GET /order/{id}/colli → ShippedCarrierInfo.DeliveryStatusUpdatedAt
    "%d-%m-%Y %H:%M:%S",
    "%d-%m-%Y %H:%M",
]

#: Monta's wall clock. A timestamp without an offset is in this zone.
MONTA_TIMEZONE = zoneinfo.ZoneInfo("Europe/Amsterdam")

#: What a tracking event carries when its source timestamp cannot be read.
PARSE_ERROR_CODE = "PARSING_ERROR"


def parse_tracking_response(
    _response: lib.Deserializable[typing.List[typing.Tuple[str, dict]]],
    settings: provider_utils.Settings,
) -> typing.Tuple[typing.List[models.TrackingDetails], typing.List[models.Message]]:
    responses = _response.deserialize()

    messages: typing.List[models.Message] = sum(
        [
            error.parse_error_response(
                [response, *(response.get("errors") or [])],
                settings,
                tracking_number=number,
            )
            for number, response in responses
        ],
        start=[],
    )
    tracking_details: typing.List[models.TrackingDetails] = []
    for number, response in responses:
        if not (any(response.get("events") or []) or any(response.get("colli") or [])):
            continue
        # One order Monta describes in a shape we cannot read must not abort
        # the batch: every other tracker in it would stay frozen, silently.
        try:
            tracking_details.append(_extract_details(response, settings, number))
        except Exception as exc:  # noqa: BLE001 — anything; the batch must survive
            messages.append(
                models.Message(
                    carrier_id=settings.carrier_id,
                    carrier_name=settings.carrier_name,
                    code=PARSE_ERROR_CODE,
                    message=f"Monta tracking data for {number} could not be parsed: {exc}",
                    details=dict(tracking_number=number),
                )
            )

    return tracking_details, messages


def _extract_details(
    data: dict,
    settings: provider_utils.Settings,
    tracking_number: str,
) -> models.TrackingDetails:
    order_events = [
        lib.to_object(monta.OrderEventResponseType, event)
        for event in (data.get("events") or [])
    ]
    colli = [
        lib.to_object(collo_schema.ColloResponseType, item)
        for item in (data.get("colli") or [])
    ]

    events = [
        models.TrackingEvent(
            **_moment(event.Occured or event.Created),
            code=event.TypeCode,
            description=event.Description or event.TypeCode,
            status=provider_units.to_tracking_status(event.TypeCode, event.Description),
        )
        for event in order_events
    ] + [
        models.TrackingEvent(
            **_moment(item.DeliveryStatusUpdated),
            code=item.DeliveryStatusCode,
            description=lib.text(
                f"Collo {item.Number}",
                item.DeliveryStatusDescription or item.DeliveryStatusCode,
                separator=": ",
            ),
            status=provider_units.to_tracking_status(
                item.DeliveryStatusCode, item.DeliveryStatusDescription
            ),
        )
        for item in colli
        if item.DeliveryStatusCode or item.DeliveryStatusDescription
    ]

    status = _overall_status(order_events, colli)
    tracking_links = [
        item.TrackAndTraceLink for item in colli if item.TrackAndTraceLink
    ]
    tracking_numbers = [
        item.TrackAndTraceCode for item in colli if item.TrackAndTraceCode
    ]

    return models.TrackingDetails(
        carrier_id=settings.carrier_id,
        carrier_name=settings.carrier_name,
        tracking_number=tracking_number,
        events=sorted(
            events, key=lambda event: str(event.timestamp or ""), reverse=True
        ),
        delivered=status == "delivered",
        status=status,
        info=models.TrackingInfo(
            carrier_tracking_link=next(iter(tracking_links), None),
            order_id=tracking_number,
            shipment_package_count=len(colli) or None,
            source="monta",
        ),
        meta=dict(
            webshop_order_id=tracking_number,
            tracking_numbers=tracking_numbers,
            tracking_links=tracking_links,
        ),
    )


def parse_instant(value: typing.Optional[str]) -> typing.Optional[datetime.datetime]:
    """A Monta timestamp as an aware UTC datetime, or None when unreadable.

    An offset in the value wins; without one the value is Monta's Amsterdam
    wall clock. Both Monta spellings are accepted (see DATETIME_FORMATS).
    """
    if not value or not str(value).strip():
        return None
    text = str(value).strip()
    for fmt in DATETIME_FORMATS:
        try:
            parsed = datetime.datetime.strptime(text, fmt)
        except ValueError:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=MONTA_TIMEZONE)
        return parsed.astimezone(datetime.timezone.utc)
    return None


def _moment(value: typing.Optional[str]) -> dict:
    """The date/time/timestamp trio of a TrackingEvent, in UTC — the same
    shapes lib.fdate / lib.flocaltime / lib.fiso_timestamp produce."""
    instant = parse_instant(value)
    if instant is None:
        return dict(date=None, time=None, timestamp=None)
    return dict(
        date=instant.strftime("%Y-%m-%d"),
        time=instant.strftime("%H:%M %p"),
        timestamp=instant.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
    )


def _overall_status(order_events: list, colli: list) -> str:
    """Carrier-level collo statuses lead; order events are the fallback."""
    collo_statuses = [
        provider_units.to_tracking_status(
            item.DeliveryStatusCode, item.DeliveryStatusDescription
        )
        for item in colli
        if item.DeliveryStatusCode or item.DeliveryStatusDescription
    ]
    known = [status for status in collo_statuses if status != "unknown"]

    if any(known):
        # the least advanced collo dictates the shipment status so a partially
        # delivered multi-box shipment stays "in_transit" until all boxes land
        for name in [status.name for status in list(provider_units.TrackingStatus)]:
            if all(status == name for status in known):
                return name
        return "in_transit"

    latest = next(
        iter(
            sorted(
                order_events,
                key=lambda event: str(event.Occured or event.Created or ""),
                reverse=True,
            )
        ),
        None,
    )

    if latest is not None:
        status = provider_units.to_tracking_status(latest.TypeCode, latest.Description)
        return status if status != "unknown" else "in_transit"

    return "in_transit"


def tracking_request(
    payload: models.TrackingRequest,
    settings: provider_utils.Settings,
) -> lib.Serializable:
    request = [dict(webshop_order_id=number) for number in payload.tracking_numbers]

    return lib.Serializable(request, lib.to_dict)
