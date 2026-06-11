"""Karrio Monta error parser."""

import typing
import karrio.lib as lib
import karrio.core.models as models
import karrio.providers.monta.utils as provider_utils


def parse_error_response(
    response: typing.Union[typing.List[dict], dict],
    settings: provider_utils.Settings,
    **kwargs,
) -> typing.List[models.Message]:
    responses = response if isinstance(response, list) else [response]
    errors: typing.List[dict] = []

    for data in responses:
        if not isinstance(data, dict):
            continue

        # Monta order validation errors (HTTP 400 OrderInvalidReasonsResponse).
        # This is where Monta's address verification failures surface.
        for reason in data.get("OrderInvalidReasons") or []:
            errors.append(
                dict(
                    code=str(reason.get("Code", "invalid")),
                    message=reason.get("Message") or "Order rejected by Monta",
                )
            )

        # ASP.NET ProblemDetails (401, 403, 500, ...) or plain string bodies
        # wrapped by utils.error_decoder ({"HttpStatus": ..., "Message": ...})
        if not data.get("OrderInvalidReasons") and (
            data.get("HttpStatus") or data.get("title") or data.get("Message")
        ):
            errors.append(
                dict(
                    code=str(data.get("HttpStatus") or data.get("status") or "error"),
                    message=(
                        lib.text(
                            data.get("title"),
                            data.get("detail"),
                            data.get("Message"),
                            separator=" - ",
                        )
                        or "Monta API request failed"
                    ),
                )
            )

    return [
        models.Message(
            carrier_id=settings.carrier_id,
            carrier_name=settings.carrier_name,
            code=error["code"],
            message=error["message"],
            details={**kwargs},
        )
        for error in errors
    ]
