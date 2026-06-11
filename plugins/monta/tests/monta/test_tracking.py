"""Monta carrier tracking tests."""

import unittest
from unittest.mock import patch
from .fixture import gateway

import karrio.sdk as karrio
import karrio.lib as lib
import karrio.core.models as models


class TestMontaTracking(unittest.TestCase):
    def setUp(self):
        self.maxDiff = None
        self.TrackingRequest = models.TrackingRequest(**TrackingPayload)

    def test_create_tracking_request(self):
        request = gateway.mapper.create_tracking_request(self.TrackingRequest)

        self.assertEqual(request.serialize(), TrackingRequest)

    def test_get_tracking(self):
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.return_value = "[]"
            karrio.Tracking.fetch(self.TrackingRequest).from_(gateway)

            urls = sorted(call[1]["url"] for call in mock.call_args_list)
            base = f"{gateway.settings.server_url}/order/SAL-ORD-2026-00001"

            self.assertEqual(urls, [f"{base}/colli", f"{base}/events"])

    def test_parse_tracking_response(self):
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = lambda **kwargs: (
                EventsResponse if kwargs["url"].endswith("/events") else ColliResponse
            )
            parsed_response = (
                karrio.Tracking.fetch(self.TrackingRequest).from_(gateway).parse()
            )

            self.assertListEqual(lib.to_dict(parsed_response), ParsedTrackingResponse)

    def test_parse_in_transit_tracking_response(self):
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = lambda **kwargs: (
                EventsResponse
                if kwargs["url"].endswith("/events")
                else InTransitColliResponse
            )
            parsed_response = (
                karrio.Tracking.fetch(self.TrackingRequest).from_(gateway).parse()
            )

            details = lib.to_dict(parsed_response)[0][0]
            self.assertEqual(details["status"], "in_transit")
            self.assertFalse(details["delivered"])

    def test_parse_error_response(self):
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.return_value = NotFoundResponse
            parsed_response = (
                karrio.Tracking.fetch(self.TrackingRequest).from_(gateway).parse()
            )

            self.assertListEqual(lib.to_dict(parsed_response), ParsedErrorResponse)


if __name__ == "__main__":
    unittest.main()


TrackingPayload = {
    "tracking_numbers": ["SAL-ORD-2026-00001"],
}

TrackingRequest = [{"webshop_order_id": "SAL-ORD-2026-00001"}]

EventsResponse = """[
    {
        "Id": 1001,
        "WebshopOrderId": "SAL-ORD-2026-00001",
        "TypeCode": "RECEIVED",
        "TypeId": 1,
        "Description": "Order received",
        "Occured": "2026-06-10T08:30:00Z",
        "Created": "2026-06-10T08:30:05Z"
    },
    {
        "Id": 1002,
        "WebshopOrderId": "SAL-ORD-2026-00001",
        "TypeCode": "SHIPPED",
        "TypeId": 7,
        "Description": "Order shipped via DHL",
        "Occured": "2026-06-10T15:00:00Z",
        "Created": "2026-06-10T15:00:05Z"
    }
]
"""

ColliResponse = """[
    {
        "Number": 1,
        "WeightGrammes": 1500,
        "TrackAndTraceCode": "3SABCD0123456789",
        "TrackAndTraceLink": "https://tracking.example.com/3SABCD0123456789",
        "DeliveryStatusDescription": "Delivered",
        "DeliveryStatusCode": "DELIVERED",
        "DeliveryStatusUpdated": "2026-06-11T13:00:00Z"
    }
]
"""

InTransitColliResponse = """[
    {
        "Number": 1,
        "WeightGrammes": 1500,
        "TrackAndTraceCode": "3SABCD0123456789",
        "TrackAndTraceLink": "https://tracking.example.com/3SABCD0123456789",
        "DeliveryStatusDescription": "In transit",
        "DeliveryStatusCode": "INTRANSIT",
        "DeliveryStatusUpdated": "2026-06-10T18:00:00Z"
    },
    {
        "Number": 2,
        "WeightGrammes": 900,
        "TrackAndTraceCode": "3SABCD0123456790",
        "TrackAndTraceLink": "https://tracking.example.com/3SABCD0123456790",
        "DeliveryStatusDescription": "Delivered",
        "DeliveryStatusCode": "DELIVERED",
        "DeliveryStatusUpdated": "2026-06-11T13:00:00Z"
    }
]
"""

NotFoundResponse = """{"HttpStatus": 404, "Message": "Order not found"}"""

ParsedTrackingResponse = [
    [
        {
            "carrier_id": "monta",
            "carrier_name": "monta",
            "tracking_number": "SAL-ORD-2026-00001",
            "delivered": True,
            "status": "delivered",
            "events": [
                {
                    "code": "DELIVERED",
                    "date": "2026-06-11",
                    "description": "Collo 1: Delivered",
                    "status": "delivered",
                    "time": "13:00 PM",
                    "timestamp": "2026-06-11T13:00:00.000Z",
                },
                {
                    "code": "SHIPPED",
                    "date": "2026-06-10",
                    "description": "Order shipped via DHL",
                    "status": "in_transit",
                    "time": "15:00 PM",
                    "timestamp": "2026-06-10T15:00:00.000Z",
                },
                {
                    "code": "RECEIVED",
                    "date": "2026-06-10",
                    "description": "Order received",
                    "status": "pending",
                    "time": "08:30 AM",
                    "timestamp": "2026-06-10T08:30:00.000Z",
                },
            ],
            "info": {
                "carrier_tracking_link": "https://tracking.example.com/3SABCD0123456789",
                "order_id": "SAL-ORD-2026-00001",
                "shipment_package_count": 1,
                "source": "monta",
            },
            "meta": {
                "webshop_order_id": "SAL-ORD-2026-00001",
                "tracking_numbers": ["3SABCD0123456789"],
                "tracking_links": ["https://tracking.example.com/3SABCD0123456789"],
            },
        }
    ],
    [],
]

ParsedErrorResponse = [
    [],
    [
        {
            "carrier_id": "monta",
            "carrier_name": "monta",
            "code": "404",
            "message": "Order not found",
            "details": {"tracking_number": "SAL-ORD-2026-00001"},
        },
        {
            "carrier_id": "monta",
            "carrier_name": "monta",
            "code": "404",
            "message": "Order not found",
            "details": {"tracking_number": "SAL-ORD-2026-00001"},
        },
    ],
]
