"""Monta carrier rate (order registration) tests."""

import unittest
from unittest.mock import patch
from .fixture import gateway

import karrio.sdk as karrio
import karrio.lib as lib
import karrio.core.models as models


class TestMontaRating(unittest.TestCase):
    def setUp(self):
        self.maxDiff = None
        self.RateRequest = models.RateRequest(**RatePayload)

    def test_create_rate_request(self):
        request = gateway.mapper.create_rate_request(self.RateRequest)

        self.assertEqual(request.serialize(), RateRequest)

    def test_get_rates_upserts_the_monta_order(self):
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.return_value = OrderResponse
            karrio.Rating.fetch(self.RateRequest).from_(gateway)

            self.assertEqual(mock.call_count, 2)
            self.assertEqual(
                mock.call_args_list[0][1]["url"],
                f"{gateway.settings.server_url}/order/SAL-ORD-2026-00001",
            )
            self.assertEqual(mock.call_args_list[0][1]["method"], "PUT")
            # a successful upsert is followed by the order read
            self.assertEqual(
                mock.call_args_list[1][1]["url"],
                f"{gateway.settings.server_url}/order/SAL-ORD-2026-00001",
            )
            self.assertEqual(mock.call_args_list[1][1]["method"], "GET")

    def test_get_rates_falls_back_to_order_creation(self):
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = [NotFoundResponse, OrderResponse, OrderResponse]
            karrio.Rating.fetch(self.RateRequest).from_(gateway)

            self.assertEqual(mock.call_count, 3)
            self.assertEqual(
                mock.call_args_list[1][1]["url"],
                f"{gateway.settings.server_url}/order",
            )
            self.assertEqual(mock.call_args_list[1][1]["method"], "POST")
            # the follow-up read only runs after the final successful upsert
            self.assertEqual(mock.call_args_list[2][1]["method"], "GET")

    def test_get_rates_falls_back_on_unknown_webshop_order_reason(self):
        # Live Monta answers a PUT for an unknown order with HTTP 400 +
        # OrderInvalidReasons Code 23, not a plain 404.
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = [
                UnknownOrderReasonResponse,
                OrderResponse,
                OrderResponse,
            ]
            karrio.Rating.fetch(self.RateRequest).from_(gateway)

            self.assertEqual(mock.call_count, 3)
            self.assertEqual(
                mock.call_args_list[1][1]["url"],
                f"{gateway.settings.server_url}/order",
            )
            self.assertEqual(mock.call_args_list[1][1]["method"], "POST")

    def test_get_rates_merges_the_order_read_over_the_upsert_body(self):
        # Empirically the upsert response does NOT carry PlannedShipmentDate —
        # Monta computes it asynchronously; only the follow-up GET serves it.
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = [UpsertOrderResponse, OrderResponse]
            parsed_response = (
                karrio.Rating.fetch(self.RateRequest).from_(gateway).parse()
            )

            self.assertEqual(mock.call_count, 2)
            self.assertEqual(
                mock.call_args_list[1][1]["url"],
                f"{gateway.settings.server_url}/order/SAL-ORD-2026-00001",
            )
            self.assertEqual(mock.call_args_list[1][1]["method"], "GET")
            self.assertListEqual(lib.to_dict(parsed_response), ParsedRateResponse)

    def test_get_rates_degrades_to_the_upsert_body_when_the_read_fails(self):
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = [UpsertOrderResponse, NotFoundResponse]
            parsed_response = (
                karrio.Rating.fetch(self.RateRequest).from_(gateway).parse()
            )

            self.assertEqual(mock.call_count, 2)
            self.assertListEqual(
                lib.to_dict(parsed_response), ParsedUpsertOnlyRateResponse
            )

    def test_parse_rate_response(self):
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.return_value = OrderResponse
            parsed_response = (
                karrio.Rating.fetch(self.RateRequest).from_(gateway).parse()
            )

            self.assertListEqual(lib.to_dict(parsed_response), ParsedRateResponse)

    def test_parse_invalid_order_response(self):
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.return_value = InvalidOrderResponse
            parsed_response = (
                karrio.Rating.fetch(self.RateRequest).from_(gateway).parse()
            )

            self.assertListEqual(
                lib.to_dict(parsed_response), ParsedInvalidOrderResponse
            )


if __name__ == "__main__":
    unittest.main()


RatePayload = {
    "reference": "SAL-ORD-2026-00001",
    "shipper": {
        "company_name": "Bamboi",
        "address_line1": "Warehouseweg 1",
        "postal_code": "1000 AA",
        "city": "Amsterdam",
        "country_code": "NL",
    },
    "recipient": {
        "person_name": "Jan van Dijk",
        "address_line1": "Keizersgracht 75 A",
        "postal_code": "1015 CE",
        "city": "Amsterdam",
        "country_code": "NL",
        "email": "jan@example.com",
        "phone_number": "+31612345678",
    },
    "parcels": [
        {
            "weight": 1.5,
            "weight_unit": "KG",
            "items": [
                {
                    "sku": "SKU-001",
                    "quantity": 2,
                    "title": "Bamboo socks",
                }
            ],
        }
    ],
}

RateRequest = {
    "webshop_order_id": "SAL-ORD-2026-00001",
    "order": {
        "WebshopOrderId": "SAL-ORD-2026-00001",
        "Reference": "SAL-ORD-2026-00001",
        "Origin": "bamboi",
        "ConsumerDetails": {
            "DeliveryAddress": {
                "FirstName": "Jan",
                "LastName": "van Dijk",
                "Street": "Keizersgracht",
                "HouseNumber": "75",
                "HouseNumberAddition": "A",
                "PostalCode": "1015 CE",
                "City": "Amsterdam",
                "CountryCode": "NL",
                "PhoneNumber": "+31612345678",
                "EmailAddress": "jan@example.com",
            },
            "InvoiceAddress": {
                "FirstName": "Jan",
                "LastName": "van Dijk",
                "Street": "Keizersgracht",
                "HouseNumber": "75",
                "HouseNumberAddition": "A",
                "PostalCode": "1015 CE",
                "City": "Amsterdam",
                "CountryCode": "NL",
                "PhoneNumber": "+31612345678",
                "EmailAddress": "jan@example.com",
            },
            "B2B": False,
            "CommunicationLanguageCode": "NL",
        },
        "Lines": [
            {
                "Sku": "SKU-001",
                "OrderedQuantity": 2,
                "Description": "Bamboo socks",
            }
        ],
    },
}

OrderResponse = """{
    "WebshopOrderId": "SAL-ORD-2026-00001",
    "Reference": "SAL-ORD-2026-00001",
    "Received": "2026-06-10T08:30:00Z",
    "Verified": "2026-06-10T08:30:05Z",
    "Backorder": false,
    "Blocked": false,
    "Picking": false,
    "MontaEorderId": 123456,
    "EstimatedDeliveryFrom": "2026-06-11T09:00:00Z",
    "EstimatedDeliveryTo": "2026-06-11T18:00:00Z",
    "PlannedShipmentDate": "2026-06-10T22:00:00Z",
    "ShipOnPlannedShipmentDate": false,
    "DeliveryDate": "2026-06-11T00:00:00Z",
    "LatestDeliveryDate": "2026-06-12T00:00:00Z",
    "OrderShipmentDays": 1
}
"""

# The upsert (PUT/POST) response as production actually serves it: no
# PlannedShipmentDate, and a staler OrderShipmentDays than the read view.
UpsertOrderResponse = """{
    "WebshopOrderId": "SAL-ORD-2026-00001",
    "Reference": "SAL-ORD-2026-00001",
    "Received": "2026-06-10T08:30:00Z",
    "Verified": "2026-06-10T08:30:05Z",
    "Backorder": false,
    "Blocked": false,
    "Picking": false,
    "MontaEorderId": 123456,
    "EstimatedDeliveryFrom": "2026-06-11T09:00:00Z",
    "EstimatedDeliveryTo": "2026-06-11T18:00:00Z",
    "ShipOnPlannedShipmentDate": false,
    "DeliveryDate": "2026-06-11T00:00:00Z",
    "LatestDeliveryDate": "2026-06-12T00:00:00Z",
    "OrderShipmentDays": 2
}
"""

NotFoundResponse = """{"HttpStatus": 404, "Message": "Order not found"}"""

UnknownOrderReasonResponse = """{
    "HttpStatus": 400,
    "OrderInvalidReasons": [
        {"Code": 23, "Message": "No orders found for webshop order id"}
    ]
}
"""

InvalidOrderResponse = """{
    "OrderInvalidReasons": [
        {"Code": 12, "Message": "DeliveryAddress.PostalCode is invalid for country NL"}
    ]
}
"""

ParsedRateResponse = [
    [
        {
            "carrier_id": "monta",
            "carrier_name": "monta",
            "currency": "EUR",
            "service": "monta_fulfillment",
            "total_charge": 0.0,
            "meta": {
                "service_name": "Monta Ship",
                "webshop_order_id": "SAL-ORD-2026-00001",
                "monta_eorder_id": 123456,
                "verified": "2026-06-10T08:30:05Z",
                "blocked": False,
                "backorder": False,
                "estimated_delivery_from": "2026-06-11T09:00:00Z",
                "estimated_delivery_to": "2026-06-11T18:00:00Z",
                "planned_shipment_date": "2026-06-10T22:00:00Z",
                "ship_on_planned_date": False,
                "monta_delivery_date": "2026-06-11T00:00:00Z",
                "latest_delivery_date": "2026-06-12T00:00:00Z",
                "order_shipment_days": 1,
            },
        }
    ],
    [],
]

# What parses when the follow-up read fails and only the upsert body remains:
# no planned_shipment_date, the upsert's own order_shipment_days, and no
# error message from the failed read.
ParsedUpsertOnlyRateResponse = [
    [
        {
            "carrier_id": "monta",
            "carrier_name": "monta",
            "currency": "EUR",
            "service": "monta_fulfillment",
            "total_charge": 0.0,
            "meta": {
                "service_name": "Monta Ship",
                "webshop_order_id": "SAL-ORD-2026-00001",
                "monta_eorder_id": 123456,
                "verified": "2026-06-10T08:30:05Z",
                "blocked": False,
                "backorder": False,
                "estimated_delivery_from": "2026-06-11T09:00:00Z",
                "estimated_delivery_to": "2026-06-11T18:00:00Z",
                "ship_on_planned_date": False,
                "monta_delivery_date": "2026-06-11T00:00:00Z",
                "latest_delivery_date": "2026-06-12T00:00:00Z",
                "order_shipment_days": 2,
            },
        }
    ],
    [],
]

ParsedInvalidOrderResponse = [
    [],
    [
        {
            "carrier_id": "monta",
            "carrier_name": "monta",
            "code": "12",
            "message": "DeliveryAddress.PostalCode is invalid for country NL — Monta log: https://www.montaportal.nl/Connect/PlatformDetails?platform=RestAPI",
            "details": {
                "montaportal": "https://www.montaportal.nl/Connect/PlatformDetails?platform=RestAPI"
            },
        }
    ],
]
