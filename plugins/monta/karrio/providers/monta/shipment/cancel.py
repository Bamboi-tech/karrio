"""Karrio Monta shipment cancellation API implementation.

Cancelling a Monta shipment deletes the order (`DELETE /order/{id}`). The
Monta v6 swagger gives that call one body, `OrderDeleteParameters`, whose only
field `Note` is required — the reason Monta shows with the deletion — so every
request carries one. Without a body Monta answers 415 Unsupported Media Type
(seen live 2026-09-03), so the old body-less DELETE never cancelled anything.
Monta rejects deletion once the order is picked/shipped (codes 18/19); that
error surfaces as a cancellation message.
"""

import typing
import karrio.lib as lib
import karrio.core.models as models
import karrio.providers.monta.error as error
import karrio.providers.monta.utils as provider_utils

# Used when the caller passes no `monta_cancel_note` option.
DEFAULT_CANCEL_NOTE = "Cancelled via Karrio"


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
    options = payload.options or {}
    request = dict(
        webshop_order_id=payload.shipment_identifier,
        note=options.get("monta_cancel_note") or DEFAULT_CANCEL_NOTE,
    )

    return lib.Serializable(request, lib.to_dict)
