"""Karrio Monta rate API implementation.

Monta has no rating endpoint: it is a fulfillment provider that selects the
actual carrier based on the shipping agreements configured in the Monta portal.

Karrio's rating call is therefore repurposed as the **order registration
phase**: `rate_request` builds the Monta order payload, the proxy upserts it
(`PUT /order/{webshoporderid}` falling back to `POST /order`), and Monta's
address verification runs at that moment. A successful upsert yields a single
flat-rate "Monta Ship" service; a rejected order yields no rates and
the `OrderInvalidReasons` surface as rate messages.
"""

import karrio.schemas.monta.order_request as monta
import karrio.schemas.monta.order_response as shipping

import typing
import datetime
import karrio.lib as lib
import karrio.core.models as models
import karrio.core.errors as errors
import karrio.providers.monta.error as error
import karrio.providers.monta.utils as provider_utils
import karrio.providers.monta.units as provider_units


def parse_rate_response(
    _response: lib.Deserializable[dict],
    settings: provider_utils.Settings,
) -> typing.Tuple[typing.List[models.RateDetails], typing.List[models.Message]]:
    response = _response.deserialize()

    messages = error.parse_error_response(response, settings)
    rates = (
        [_extract_details(response, settings)]
        if not any(messages) and response.get("WebshopOrderId") is not None
        else []
    )

    return rates, messages


def _extract_details(
    data: dict,
    settings: provider_utils.Settings,
) -> models.RateDetails:
    order = lib.to_object(shipping.OrderResponseType, data)

    return models.RateDetails(
        carrier_id=settings.carrier_id,
        carrier_name=settings.carrier_name,
        service=provider_units.ShippingService.monta_fulfillment.name,
        total_charge=0.0,
        currency="EUR",
        # Date semantics (Monta, 24-08-2026): planned_shipment_date is the
        # planned ship day (ship_on_planned_date false = on or before it,
        # true = exactly on it); estimated_delivery_from/to is Monta's
        # delivery forecast; monta_delivery_date (DeliveryDate) is the ACTUAL
        # delivery day registered afterwards from carrier feedback — never a
        # forecast, so pre-shipment it is normally null.
        meta=dict(
            service_name=provider_units.ShippingService.monta_fulfillment.value,
            webshop_order_id=order.WebshopOrderId,
            monta_eorder_id=order.MontaEorderId,
            verified=order.Verified,
            blocked=order.Blocked,
            blocked_message=order.BlockedMessage,
            backorder=order.Backorder,
            estimated_delivery_from=order.EstimatedDeliveryFrom,
            estimated_delivery_to=order.EstimatedDeliveryTo,
            planned_shipment_date=order.PlannedShipmentDate,
            ship_on_planned_date=order.ShipOnPlannedShipmentDate,
            monta_delivery_date=order.DeliveryDate,
            latest_delivery_date=order.LatestDeliveryDate,
            order_shipment_days=order.OrderShipmentDays,
        ),
    )


# The two spellings the ERP sends for a date hint. A timestamp is judged as an
# instant, a bare date as a calendar day (see _actionable_date_hint).
TIMESTAMP_HINT_FORMATS = ["%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S"]
DATE_HINT_FORMATS = ["%Y-%m-%d"]


def _utc_now() -> datetime.datetime:
    """The clock the date-hint guard reads; a seam so tests can freeze it."""
    return datetime.datetime.now(datetime.timezone.utc)


def _parse_hint(
    value: str, formats: typing.List[str]
) -> typing.Optional[datetime.datetime]:
    # current_format repeats the first spelling on purpose: lib.to_date falls
    # back to it when every try_format misses, and its default ("%Y-%m-%d")
    # would let a bare date pass as a midnight timestamp.
    return lib.failsafe(
        lambda: lib.to_date(value, current_format=formats[0], try_formats=formats)
    )


def _actionable_date_hint(
    value: typing.Optional[str],
    allow_today: bool = False,
) -> typing.Optional[str]:
    """Return the date hint only when Monta can still act on it.

    Monta rejects an order whose DeliveryDateRequested is in the past, and a
    PlannedShipmentDate whose moment has passed gets the whole order rejected
    as well (code 12 "Planned shipment date is in the past" — seen live on
    21-09-2026: a 12:00:00Z hint sent at 13:14 UTC; the same hint sent at
    10:58 UTC was accepted). Dropping the hint is always safe:
    DeliveryDateRequested is only a request toward Monta's shipping process
    (per Monta, 24-08-2026 — it does not make Monta compute or return dates),
    and Monta plans its own PlannedShipmentDate regardless, which reaches
    consumers via the rate meta and the post-upsert order read when Monta
    serves it.

    A value carrying a time is compared as an instant against now (UTC); a
    naive timestamp is read as UTC — the ERP always sends a trailing Z, and a
    bare wall clock has no better reading here. A bare date is compared as a
    calendar day against today in UTC. ``allow_today`` admits the current day
    (an instant still ahead of us, or today's date); without it the day itself
    must be a later one — same-day delivery is never honorable, whatever the
    hour. An unparseable value is dropped for the same reason — we cannot
    prove it is still actionable. The original string is returned untouched.
    """
    if value is None:
        return None

    now = _utc_now()
    today = now.date()

    instant = _parse_hint(value, TIMESTAMP_HINT_FORMATS)
    if instant is not None:
        if instant.tzinfo is None:
            instant = instant.replace(tzinfo=datetime.timezone.utc)
        instant = instant.astimezone(datetime.timezone.utc)
        is_actionable = instant > now and (allow_today or instant.date() > today)
        return value if is_actionable else None

    day = _parse_hint(value, DATE_HINT_FORMATS)
    if day is None:
        return None

    is_actionable = day.date() > today or (allow_today and day.date() == today)
    return value if is_actionable else None


def rate_request(
    payload: models.RateRequest,
    settings: provider_utils.Settings,
) -> lib.Serializable:
    recipient = lib.to_address(payload.recipient)
    packages = lib.to_packages(payload.parcels)
    options = lib.to_shipping_options(
        payload.options,
        package_options=packages.options,
        initializer=provider_units.shipping_options_initializer,
    )

    webshop_order_id = options.monta_webshop_order_id.state or payload.reference

    if not webshop_order_id:
        raise errors.ShippingSDKError(
            "A 'reference' (or 'monta_webshop_order_id' option) is required: "
            "Monta orders are keyed by the client supplied WebshopOrderId."
        )

    street, house_number, addition = provider_utils.parse_house_number(recipient)
    first_name, *last_names = (recipient.person_name or "").split(" ")
    delivery_address = monta.AddressType(
        Company=recipient.company_name,
        FirstName=first_name or None,
        LastName=" ".join(last_names) or None,
        Street=lib.text(street, recipient.address_line2),
        HouseNumber=house_number or None,
        HouseNumberAddition=addition or None,
        PostalCode=recipient.postal_code,
        City=recipient.city,
        State=recipient.state_code,
        CountryCode=recipient.country_code,
        PhoneNumber=recipient.phone_number,
        EmailAddress=recipient.email,
    )

    request = monta.OrderRequestType(
        WebshopOrderId=webshop_order_id,
        Reference=payload.reference or webshop_order_id,
        Origin=(options.monta_origin.state or settings.connection_config.origin.state),
        ConsumerDetails=monta.ConsumerDetailsType(
            DeliveryAddress=delivery_address,
            InvoiceAddress=delivery_address,
            B2B=(
                options.monta_b2b.state
                if options.monta_b2b.state is not None
                else bool(recipient.company_name)
            ),
            ShippingComment=options.monta_shipping_comment.state,
            CommunicationLanguageCode=recipient.country_code,
        ),
        # Shipping today is legitimate as long as the moment has not passed:
        # a same-day timestamp still ahead of us is kept, one behind us is a
        # stale hint Monta rejects the whole order over (code 12).
        PlannedShipmentDate=_actionable_date_hint(
            options.monta_planned_shipment_date.state, allow_today=True
        ),
        ShipperCode=(
            options.monta_shipper_code.state
            or settings.connection_config.shipper_code.state
        ),
        # A same-day (or past) requested delivery date gets the whole order
        # rejected — the day must be strictly after today (UTC), whatever the
        # hour, or the hint is dropped.
        DeliveryDateRequested=_actionable_date_hint(
            options.monta_delivery_date_requested.state
        ),
        Lines=[
            monta.LineType(
                Sku=(item.sku or item.id or item.title),
                OrderedQuantity=item.quantity,
                WebshopOrderLineId=lib.text(item.id),
                Description=lib.text(item.title or item.description, max=100),
            )
            for package in packages
            for item in package.items
        ],
        AllowedShippers=(
            options.monta_allowed_shippers.state
            or settings.connection_config.allowed_shippers.state
        ),
        Comment=options.monta_comment.state,
    )

    return lib.Serializable(
        dict(webshop_order_id=webshop_order_id, order=lib.to_dict(request)),
        lib.to_dict,
    )
