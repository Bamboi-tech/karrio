"""Karrio Monta shipment cancellation API implementation.

Cancelling a Monta shipment deletes the order (`DELETE /order/{id}`). Monta
rejects deletion once the order is picked/shipped; that error surfaces as a
cancellation message.
"""

import typing
import karrio.lib as lib
import karrio.core.models as models
import karrio.providers.monta.error as error
import karrio.providers.monta.utils as provider_utils


def parse_shipment_cancel_response(
    _response: lib.Deserializable[dict],
    settings: provider_utils.Settings,
) -> typing.Tuple[models.ConfirmationDetails, typing.List[models.Message]]:
    response = _response.deserialize()
    messages = error.parse_error_response(response, settings)

    confirmation = (
        models.ConfirmationDetails(
            carrier_id=settings.carrier_id,
            carrier_name=settings.carrier_name,
            operation="Cancel Shipment",
            success=True,
        )
        if not any(messages)
        else None
    )

    return confirmation, messages


def shipment_cancel_request(
    payload: models.ShipmentCancelRequest,
    settings: provider_utils.Settings,
) -> lib.Serializable:
    request = dict(webshop_order_id=payload.shipment_identifier)

    return lib.Serializable(request, lib.to_dict)
