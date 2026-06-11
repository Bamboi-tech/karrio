"""Karrio Monta rate API implementation.

Monta has no rating endpoint: it is a fulfillment provider that selects the
actual carrier based on the shipping agreements configured in the Monta portal.

Karrio's rating call is therefore repurposed as the **order registration
phase**: `rate_request` builds the Monta order payload, the proxy upserts it
(`PUT /order/{webshoporderid}` falling back to `POST /order`), and Monta's
address verification runs at that moment. A successful upsert yields a single
flat-rate "Monta Fulfillment" service; a rejected order yields no rates and
the `OrderInvalidReasons` surface as rate messages.
"""

import karrio.schemas.monta.order_request as monta
import karrio.schemas.monta.order_response as shipping

import typing
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
        ),
    )


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
        Origin=(
            options.monta_origin.state or settings.connection_config.origin.state
        ),
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
        PlannedShipmentDate=options.monta_planned_shipment_date.state,
        ShipperCode=(
            options.monta_shipper_code.state
            or settings.connection_config.shipper_code.state
        ),
        DeliveryDateRequested=options.monta_delivery_date_requested.state,
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
