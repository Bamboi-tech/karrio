"""Karrio Monta client proxy."""

import urllib.parse
import karrio.lib as lib
import karrio.api.proxy as proxy
import karrio.providers.monta.utils as provider_utils
import karrio.mappers.monta.settings as provider_settings


class Proxy(proxy.Proxy):
    settings: provider_settings.Settings

    @property
    def _headers(self) -> dict:
        return {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Basic {self.settings.authorization}",
        }

    def _order_url(self, webshop_order_id: str, *paths: str) -> str:
        return "/".join(
            [
                f"{self.settings.server_url}/order/{urllib.parse.quote(webshop_order_id, safe='')}",
                *[urllib.parse.quote(path, safe="") for path in paths],
            ]
        )

    def get_rates(self, request: lib.Serializable) -> lib.Deserializable[str]:
        """Upsert the Monta order: PUT /order/{id}, falling back to POST /order
        when the order does not exist yet. Monta verifies the delivery address
        here; failures surface as rate messages."""
        payload = request.serialize()
        order = lib.to_json(payload["order"])

        response = lib.request(
            url=self._order_url(payload["webshop_order_id"]),
            data=order,
            method="PUT",
            trace=self.trace_as("json"),
            headers=self._headers,
            on_error=provider_utils.error_decoder,
        )

        if (lib.to_dict(response) or {}).get("HttpStatus") == 404:
            response = lib.request(
                url=f"{self.settings.server_url}/order",
                data=order,
                method="POST",
                trace=self.trace_as("json"),
                headers=self._headers,
                on_error=provider_utils.error_decoder,
            )

        return lib.Deserializable(response, lib.to_dict)

    def create_shipment(self, request: lib.Serializable) -> lib.Deserializable[str]:
        """Packing phase chain: register colli, create the shipping labels
        (which marks the order as shipped in Monta), download the label files
        and optionally fetch return label references."""
        payload = request.serialize()
        webshop_order_id = payload["webshop_order_id"]
        errors: list = []

        def request_json(url: str, method: str = "GET", data: dict = None) -> dict:
            response = lib.to_dict(
                lib.request(
                    url=url,
                    method=method,
                    trace=self.trace_as("json"),
                    headers=self._headers,
                    on_error=provider_utils.error_decoder,
                    **({"data": lib.to_json(data)} if data is not None else {}),
                )
            )

            if isinstance(response, dict) and (
                response.get("HttpStatus") or response.get("OrderInvalidReasons")
            ):
                errors.append(response)
                return {}

            return response

        # 1. idempotency guard: only register colli that don't exist yet
        existing = request_json(self._order_url(webshop_order_id, "colli"))
        existing_numbers = [
            collo.get("Number")
            for collo in (existing if isinstance(existing, list) else [])
        ]
        colli = [
            request_json(
                self._order_url(webshop_order_id, "colli"), "POST", data=collo
            )
            for collo in payload["colli"]
            if collo.get("Number") not in existing_numbers
        ] + (existing if isinstance(existing, list) else [])

        # 2. create the shipping labels — this flips the order to shipped!
        labels = (
            lib.to_dict(
                lib.request(
                    url=(
                        self._order_url(webshop_order_id, "shippinglabels")
                        + f"?{urllib.parse.urlencode(dict(labelfiletype=payload['label_file_type']))}"
                    ),
                    method="POST",
                    trace=self.trace_as("json"),
                    headers=self._headers,
                    on_error=provider_utils.error_decoder,
                )
            )
            if not any(errors)
            else []
        )

        if isinstance(labels, dict):
            errors.append(labels)
            labels = []

        # 3. download each label file as base64 PDF
        for label in labels:
            label["file"] = (
                lib.request(
                    url=self._order_url(
                        webshop_order_id, "shippinglabels", label["FileName"]
                    ),
                    method="GET",
                    trace=self.trace_as("json"),
                    headers={
                        "Accept": "application/pdf",
                        "Authorization": f"Basic {self.settings.authorization}",
                    },
                    decoder=lib.encode_base64,
                    on_error=lambda _: "",
                )
                if label.get("FileName")
                else ""
            )

        # 4. optional return label references (no file content in Monta v6)
        return_labels = (
            request_json(self._order_url(webshop_order_id, "returnlabels"))
            if payload.get("include_return_labels") and any(labels)
            else []
        )

        return lib.Deserializable(
            lib.to_json(
                dict(
                    webshop_order_id=webshop_order_id,
                    colli=[collo for collo in colli if any(collo or {})],
                    labels=labels,
                    return_labels=(
                        return_labels if isinstance(return_labels, list) else []
                    ),
                    errors=errors,
                )
            ),
            lib.to_dict,
        )

    def cancel_shipment(self, request: lib.Serializable) -> lib.Deserializable[str]:
        payload = request.serialize()

        response = lib.request(
            url=self._order_url(payload["webshop_order_id"]),
            method="DELETE",
            trace=self.trace_as("json"),
            headers=self._headers,
            on_error=provider_utils.error_decoder,
        )

        return lib.Deserializable(response or "{}", lib.to_dict)

    def get_tracking(self, request: lib.Serializable) -> lib.Deserializable[str]:
        """Fetch order events + colli delivery statuses per tracked order."""

        def track(payload: dict) -> tuple:
            webshop_order_id = payload["webshop_order_id"]
            errors: list = []

            def request_json(url: str):
                response = lib.to_dict(
                    lib.request(
                        url=url,
                        method="GET",
                        trace=self.trace_as("json"),
                        headers=self._headers,
                        on_error=provider_utils.error_decoder,
                    )
                )

                if isinstance(response, dict) and response.get("HttpStatus"):
                    errors.append(response)
                    return []

                return response if isinstance(response, list) else []

            return (
                webshop_order_id,
                dict(
                    events=request_json(self._order_url(webshop_order_id, "events")),
                    colli=request_json(self._order_url(webshop_order_id, "colli")),
                    errors=errors,
                ),
            )

        responses = lib.run_asynchronously(track, request.serialize())

        return lib.Deserializable(
            responses,
            lambda __: [(number, data) for number, data in __],
        )
