"""Monta carrier tracking tests."""

import unittest
from unittest.mock import patch
from .fixture import gateway

import karrio.sdk as karrio
import karrio.lib as lib
import karrio.core.models as models
import karrio.providers.monta.units as units
import karrio.providers.monta.tracking as tracking


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

    def test_parse_live_get_colli_shape_with_dutch_timestamps(self):
        # Regression (2026-09-10/11): the GET /colli summary dates its carrier
        # status "11-9-2026 16:22:39" — day-first, unpadded, Amsterdam wall
        # clock. That raised inside the batch parser and froze every Monta
        # tracker; and the ISO-ish event times were emitted as if UTC.
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = lambda **kwargs: (
                LiveEventsResponse
                if kwargs["url"].endswith("/events")
                else LiveColliResponse
            )
            parsed_response = (
                karrio.Tracking.fetch(self.TrackingRequest).from_(gateway).parse()
            )

            details, messages = lib.to_dict(parsed_response)
            self.assertEqual(messages, [])
            self.assertEqual(details[0]["status"], "delivered")
            self.assertTrue(details[0]["delivered"])
            self.assertEqual(
                [
                    (e["code"], e["status"], e["timestamp"])
                    for e in details[0]["events"]
                ],
                [
                    ("Delivered", "delivered", "2026-09-11T16:38:22.000Z"),
                    ("Delivered", "delivered", "2026-09-11T14:22:39.000Z"),
                    ("Delivered", "delivered", "2026-09-11T14:22:39.000Z"),
                    ("EnRoute", "in_transit", "2026-09-11T03:37:20.000Z"),
                    ("Shipped", "in_transit", "2026-09-10T13:41:14.000Z"),
                    ("Packing", "picked_up", "2026-09-10T13:41:14.000Z"),
                ],
            )
            self.assertEqual(
                details[0]["meta"]["tracking_numbers"],
                ["JVGL06212989001384873785", "JVGL06212989001118007075"],
            )

    def test_one_unreadable_order_does_not_abort_the_batch(self):
        real = tracking._extract_details

        def flaky(data, settings, number):
            if number == "SAL-ORD-2026-00002":
                raise ValueError("boom")
            return real(data, settings, number)

        request = models.TrackingRequest(
            tracking_numbers=["SAL-ORD-2026-00001", "SAL-ORD-2026-00002"]
        )
        with patch("karrio.mappers.monta.proxy.lib.request") as mock, patch(
            "karrio.providers.monta.tracking._extract_details", side_effect=flaky
        ):
            mock.side_effect = lambda **kwargs: (
                EventsResponse if kwargs["url"].endswith("/events") else ColliResponse
            )
            details, messages = lib.to_dict(
                karrio.Tracking.fetch(request).from_(gateway).parse()
            )

        self.assertEqual(
            [d["tracking_number"] for d in details], ["SAL-ORD-2026-00001"]
        )
        self.assertEqual(
            [(m["code"], m["details"]["tracking_number"]) for m in messages],
            [("PARSING_ERROR", "SAL-ORD-2026-00002")],
        )


class TestMontaTimestamps(unittest.TestCase):
    """Monta's clock is Europe/Amsterdam without an offset; Karrio speaks UTC."""

    def test_offset_in_the_value_wins(self):
        self.assertEqual(
            tracking.parse_instant("2026-06-10T08:30:00Z").isoformat(),
            "2026-06-10T08:30:00+00:00",
        )

    def test_naive_event_time_is_amsterdam_summer(self):
        self.assertEqual(
            tracking.parse_instant("2026-09-10T15:41:14.147").isoformat(),
            "2026-09-10T13:41:14.147000+00:00",
        )

    def test_dutch_collo_time_is_amsterdam_winter(self):
        self.assertEqual(
            tracking.parse_instant("5-1-2026 10:00:00").isoformat(),
            "2026-01-05T09:00:00+00:00",
        )

    def test_unreadable_or_empty_yields_no_moment(self):
        for value in [None, "", "   ", "yesterday", "2026-13-40T00:00:00"]:
            self.assertIsNone(tracking.parse_instant(value), value)
        self.assertEqual(
            tracking._moment("yesterday"), dict(date=None, time=None, timestamp=None)
        )


class TestMontaStatusMapping(unittest.TestCase):
    """Every event TypeCode Monta documents on the /orderevents feed must map
    to a sane Karrio status — including the ones whose keywords mislead."""

    def test_documented_event_codes(self):
        for code, expected in {
            "EnRoute": "in_transit",
            "AvailablePickup": "ready_for_pickup",
            "Delivered": "delivered",
            "Collected": "delivered",
            "DeliveryFailed": "delivery_failed",
            "NoDeliveryStatusFromCarrier": "unknown",
            "Returned": "return_to_sender",
            "Unblocked": "pending",
            "VerifyingBlocked": "on_hold",
            "LineDeleted": "unknown",
            "OrderDeleted": "cancelled",
            "Backorder": "pending",
            "OutOfBackorder": "pending",
            "Picking": "picked_up",
            "Packing": "picked_up",
            "Shipped": "in_transit",
        }.items():
            self.assertEqual(units.to_tracking_status(code), expected, code)

    def test_unblocked_is_not_on_hold_despite_the_blocked_substring(self):
        # Regression: seen live — Unblocked events matched the BLOCKED keyword.
        self.assertEqual(
            units.to_tracking_status("Unblocked", "Order released from hold"),
            "pending",
        )

    def test_undocumented_blocked_code_still_lands_on_hold(self):
        self.assertEqual(units.to_tracking_status("Blocked"), "on_hold")

    def test_collected_in_free_text_does_not_mean_delivered(self):
        # Only the exact event code maps; a description mentioning "collected"
        # next to a real carrier code must not override that code.
        self.assertEqual(
            units.to_tracking_status("EnRoute", "Collected by carrier driver"),
            "in_transit",
        )


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

# Verbatim shapes from production, 2026-09-11 (order SO-Shopify-06352, two DHL
# colli delivered to a parcel locker). Note the naive event times and the
# Dutch day-first collo timestamp.
LiveEventsResponse = """[
    {"Id": 4, "WebshopOrderId": "SAL-ORD-2026-00001", "TypeCode": "Delivered",
     "Description": "Delivery status changed to Delivered: status update from DHLFYPakket",
     "Occured": "2026-09-11T18:38:22.173", "Created": "2026-09-11T18:38:22.173"},
    {"Id": 3, "WebshopOrderId": "SAL-ORD-2026-00001", "TypeCode": "EnRoute",
     "Description": "Delivery status changed to En route: status update from DHLFYPakket",
     "Occured": "2026-09-11T05:37:20.017", "Created": "2026-09-11T05:37:20.017"},
    {"Id": 2, "WebshopOrderId": "SAL-ORD-2026-00001", "TypeCode": "Shipped",
     "Description": "Shipped (ready for shipper pickup): 'Shipping labels gemaakt via de REST api'.",
     "Occured": "2026-09-10T15:41:14.17", "Created": "2026-09-10T15:41:14.17"},
    {"Id": 1, "WebshopOrderId": "SAL-ORD-2026-00001", "TypeCode": "Packing",
     "Description": "Set to picked: ''Picked' automatically set when order is marked as shipped'.",
     "Occured": "2026-09-10T15:41:14.15", "Created": "2026-09-10T15:41:14.15"}
]
"""

LiveColliResponse = """{
    "TotalWeightInKg": 0, "PalletsShipped": 0, "BoxesShipped": 2,
    "ShippedPallets": {}, "ShippedBoxesOnPallets": [],
    "ShippedBoxesNotOnPallets": [
        {"DistinctProducts": 0, "TotalProducts": 0, "ShippedCarrierInfo": {
            "TTColloNr": 1, "PackageDescription": "Eigen verpakking product",
            "WeightInGrams": 3, "LengthInMM": 400, "WidthInMM": 300, "HeightInMM": 200,
            "TTCode": "JVGL06212989001384873785",
            "TTLink": "https://my.dhlecommerce.nl/home/tracktrace/JVGL06212989001384873785/1071ZL?lang=nl_NL",
            "DeliveryStatusDescription": "Afgeleverd in postbus",
            "DeliveryStatusCode": "Delivered",
            "DeliveryStatusUpdatedAt": "11-9-2026 16:22:39"}},
        {"DistinctProducts": 0, "TotalProducts": 0, "ShippedCarrierInfo": {
            "TTColloNr": 2, "PackageDescription": "Eigen verpakking product",
            "WeightInGrams": 3, "LengthInMM": 400, "WidthInMM": 300, "HeightInMM": 200,
            "TTCode": "JVGL06212989001118007075",
            "TTLink": "https://my.dhlecommerce.nl/home/tracktrace/JVGL06212989001118007075/1071ZL?lang=nl_NL",
            "DeliveryStatusDescription": "Afgeleverd in postbus",
            "DeliveryStatusCode": "Delivered",
            "DeliveryStatusUpdatedAt": "11-9-2026 16:22:39"}}
    ]
}
"""

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

# One message, not two: /events decides whether the order exists, while a
# failing /colli only means no boxes are registered yet — normal for anything
# Monta has not packed, and never worth reporting on its own.
ParsedErrorResponse = [
    [],
    [
        {
            "carrier_id": "monta",
            "carrier_name": "monta",
            "code": "404",
            "message": "Order not found — Monta log: https://www.montaportal.nl/Connect/PlatformDetails?platform=RestAPI",
            "details": {
                "montaportal": "https://www.montaportal.nl/Connect/PlatformDetails?platform=RestAPI",
                "tracking_number": "SAL-ORD-2026-00001",
            },
        },
    ],
]
