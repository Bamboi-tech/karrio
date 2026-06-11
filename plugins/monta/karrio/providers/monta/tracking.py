"""Karrio Monta tracking API implementation.

Karrio trackers for Monta shipments are keyed by the Monta WebshopOrderId
(== the shipment's tracking_number). For each tracker the proxy fetches:

- `GET /order/{id}/events`  -> order event history (received, picked, shipped...)
- `GET /order/{id}/colli`   -> per-box carrier delivery status + T&T codes

Both sources are merged into one normalized Karrio event stream. The overall
status is taken from the collo carrier statuses when available (these reflect
the actual DHL/DPD/PostNL delivery state), falling back to the latest order
event.
"""

import karrio.schemas.monta.order_event_response as monta
import karrio.schemas.monta.collo_response as collo_schema

import typing
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
]


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
    tracking_details = [
        _extract_details(response, settings, number)
        for number, response in responses
        if any(response.get("events") or []) or any(response.get("colli") or [])
    ]

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
            date=lib.fdate(event.Occured or event.Created, try_formats=DATETIME_FORMATS),
            time=lib.flocaltime(event.Occured or event.Created, try_formats=DATETIME_FORMATS),
            timestamp=lib.fiso_timestamp(event.Occured or event.Created, try_formats=DATETIME_FORMATS),
            code=event.TypeCode,
            description=event.Description or event.TypeCode,
            status=provider_units.to_tracking_status(event.TypeCode, event.Description),
        )
        for event in order_events
    ] + [
        models.TrackingEvent(
            date=lib.fdate(item.DeliveryStatusUpdated, try_formats=DATETIME_FORMATS),
            time=lib.flocaltime(item.DeliveryStatusUpdated, try_formats=DATETIME_FORMATS),
            timestamp=lib.fiso_timestamp(item.DeliveryStatusUpdated, try_formats=DATETIME_FORMATS),
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
    tracking_links = [item.TrackAndTraceLink for item in colli if item.TrackAndTraceLink]
    tracking_numbers = [item.TrackAndTraceCode for item in colli if item.TrackAndTraceCode]

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

    latest = next(iter(sorted(
        order_events,
        key=lambda event: str(event.Occured or event.Created or ""),
        reverse=True,
    )), None)

    if latest is not None:
        status = provider_units.to_tracking_status(latest.TypeCode, latest.Description)
        return status if status != "unknown" else "in_transit"

    return "in_transit"


def tracking_request(
    payload: models.TrackingRequest,
    settings: provider_utils.Settings,
) -> lib.Serializable:
    request = [
        dict(webshop_order_id=number) for number in payload.tracking_numbers
    ]

    return lib.Serializable(request, lib.to_dict)
