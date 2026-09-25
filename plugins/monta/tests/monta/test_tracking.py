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

    def test_carrier_text_does_not_turn_en_route_into_delivered(self):
        # Regression (SO-Shopify-06412, GLS, 2026-09-14): an EnRoute event
        # whose text says the parcel "is expected to be delivered during the
        # day" read as delivered — the keyword scan matched DELIVERED in the
        # description before ENROUTE in the code. On 06412 the colli were
        # already EnRoute and led; without a collo carrier status (none yet,
        # or only the pre-announcement) such an event sets the tracker, and
        # through it the Karrio shipment and the ERP, to Delivered.
        for case, colli in [
            ("no collo status yet", GlsRegisteredColliResponse),
            ("colli pre-announced", GlsPreAnnouncedColliResponse),
        ]:
            with self.subTest(case), patch(
                "karrio.mappers.monta.proxy.lib.request"
            ) as mock:
                mock.side_effect = lambda colli=colli, **kwargs: (
                    ExpectedTodayEventsResponse
                    if kwargs["url"].endswith("/events")
                    else colli
                )
                details, messages = lib.to_dict(
                    karrio.Tracking.fetch(self.TrackingRequest).from_(gateway).parse()
                )

                self.assertEqual(messages, [])
                self.assertEqual(details[0]["status"], "in_transit")
                self.assertFalse(details[0]["delivered"])
                latest = details[0]["events"][0]
                self.assertEqual(
                    (latest["code"], latest["status"]), ("EnRoute", "in_transit")
                )

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
                    ("Shipped", "picked_up", "2026-09-10T13:41:14.000Z"),
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
            "Shipped": "picked_up",
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

    def test_not_yet_en_route_is_pending_despite_the_enroute_substring(self):
        # Regression (2026-09-22, SO-Shopify-06812): the DHL pre-announcement
        # on the collo contains ENROUTE and landed on in_transit.
        self.assertEqual(
            units.to_tracking_status(
                "NotYetEnRoute", "Voorgemeld bij verzender, nog niet in distributie"
            ),
            "pending",
        )

    def test_shipped_in_a_warehouse_text_is_no_carrier_movement(self):
        # Monta's warehouse texts say "shipped" when the label is made; a
        # warehouse code carrying such a text must not read as in_transit.
        self.assertEqual(
            units.to_tracking_status(
                "Picking",
                "Set to picked: ''Picked' automatically set when order is marked as shipped'.",
            ),
            "picked_up",
        )

    def test_collected_in_free_text_does_not_mean_delivered(self):
        # Only the exact event code maps; a description mentioning "collected"
        # next to a real carrier code must not override that code.
        self.assertEqual(
            units.to_tracking_status("EnRoute", "Collected by carrier driver"),
            "in_transit",
        )

    def test_description_never_overrides_a_known_code(self):
        # Regression (SO-Shopify-06412, GLS): code and description were
        # scanned together, status by status, so DELIVERED in the text beat
        # the ENROUTE code. A code that maps decides; its text does not.
        for description in [
            "expected to be delivered during the day",
            "Delivery status changed to En route: status update from GLS "
            "(00XX0001): The parcel is expected to be delivered during the day. (11)",
        ]:
            self.assertEqual(
                units.to_tracking_status("EnRoute", description),
                "in_transit",
                description,
            )

    def test_description_speaks_for_an_unknown_code(self):
        # Monta publishes no enum for collo DeliveryStatusCodes: when the code
        # itself matches nothing, its text still decides.
        self.assertEqual(
            units.to_tracking_status("XYZ", "Afgeleverd bij de buren"), "delivered"
        )
        self.assertEqual(
            units.to_tracking_status("XYZ", "Status onbekend bij vervoerder"),
            "unknown",
        )


class TestMontaWarehouseEventsStayPending(unittest.TestCase):
    """Monta marks an order Shipped the moment its labels exist, while the box
    is still on the warehouse floor; the first real carrier scan comes that
    night in the sorting centre. Until then the tracker stays pending, which
    leaves the Karrio shipment (and the ERP's Label Created) where it is.
    Only a carrier status or the order's own fate may move it."""

    def setUp(self):
        self.maxDiff = None
        self.TrackingRequest = models.TrackingRequest(**TrackingPayload)

    def _track(self, events: str, colli: str) -> dict:
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = lambda **kwargs: (
                events if kwargs["url"].endswith("/events") else colli
            )
            details, messages = lib.to_dict(
                karrio.Tracking.fetch(self.TrackingRequest).from_(gateway).parse()
            )

        self.assertEqual(messages, [])
        return details[0]

    def _status_after(self, *events, colli: str = "[]") -> str:
        """The overall status after these order events (a TypeCode, or a
        (TypeCode, Description) pair), oldest first."""
        pairs = [
            event if isinstance(event, tuple) else (event, None) for event in events
        ]
        feed = lib.to_json(
            [
                dict(
                    Id=index,
                    WebshopOrderId="SAL-ORD-2026-00001",
                    TypeCode=code,
                    Description=description,
                    Occured=f"2026-09-22T1{index}:00:00",
                    Created=f"2026-09-22T1{index}:00:00",
                )
                for index, (code, description) in enumerate(pairs)
            ]
        )
        return self._track(feed, colli)["status"]

    def _colli(self, *codes: str) -> str:
        """A collo list (POST shape) with these DeliveryStatusCodes."""
        return lib.to_json(
            [
                dict(
                    Number=number,
                    TrackAndTraceCode=f"0521200000000{number}",
                    DeliveryStatusCode=code,
                    DeliveryStatusUpdated="23-9-2026 22:00:00",
                )
                for number, code in enumerate(codes, start=1)
            ]
        )

    def test_label_only_order_stays_pending(self):
        # (a) SO-Shopify-06855, 2026-09-23: Packing + Shipped at label
        # creation, the box registered without a carrier status yet. Went
        # in_transit half an hour later in production.
        details = self._track(LabelOnlyEventsResponse, LabelOnlyColliResponse)

        self.assertEqual(details["status"], "pending")
        self.assertFalse(details["delivered"])
        self.assertEqual(
            [(e["code"], e["status"]) for e in details["events"]],
            [("Shipped", "picked_up"), ("Packing", "picked_up")],
        )
        self.assertEqual(details["meta"]["tracking_numbers"], ["05212000000001"])

    def test_pre_announced_collo_stays_pending(self):
        # (b) SO-Shopify-06812, 2026-09-22: the collo reads NotYetEnRoute
        # ("Voorgemeld bij verzender, nog niet in distributie").
        details = self._track(PreAnnouncedEventsResponse, PreAnnouncedColliResponse)

        self.assertEqual(details["status"], "pending")
        self.assertEqual(
            [(e["code"], e["status"]) for e in details["events"]],
            [
                ("Shipped", "picked_up"),
                ("Packing", "picked_up"),
                ("Unblocked", "pending"),
                ("Blocked", "on_hold"),
                ("NotYetEnRoute", "pending"),
            ],
        )

    def test_first_carrier_scan_moves_the_shipment(self):
        # (c) SO-Shopify-06855 that night: DPD sorted the box.
        details = self._track(FirstScanEventsResponse, FirstScanColliResponse)

        self.assertEqual(details["status"], "in_transit")
        self.assertEqual(
            [(e["code"], e["status"]) for e in details["events"]],
            [
                ("EnRoute", "in_transit"),
                ("EnRoute", "in_transit"),
                ("Shipped", "picked_up"),
                ("Packing", "picked_up"),
            ],
        )

    def test_no_events_is_pending(self):
        # (d) a registered box and no order events: nothing is known yet.
        self.assertEqual(
            self._track("[]", LabelOnlyColliResponse)["status"], "pending"
        )
        self.assertEqual(tracking._overall_status([], []), "pending")

    def test_warehouse_steps_never_decide(self):
        for codes in [
            ("Received",),
            ("Received", "Verified", "Picking"),
            ("Packing", "Shipped"),
            ("Backorder", "OutOfBackorder"),
            ("Packing", "Shipped", "LineDeleted"),
            ("Packing", "Shipped", "NoDeliveryStatusFromCarrier"),
        ]:
            self.assertEqual(self._status_after(*codes), "pending", codes)

    def test_order_fate_and_carrier_events_still_decide(self):
        # (e) Unblocked stays pending, OrderDeleted stays cancelled, and the
        # carrier events on the order feed keep working without colli.
        for codes, expected in [
            (("Packing", "Shipped", "Blocked", "Unblocked"), "pending"),
            (("Received", "OrderDeleted"), "cancelled"),
            (("Packing", "Shipped", "Blocked"), "on_hold"),
            (("Received", "VerifyingBlocked"), "on_hold"),
            (("Packing", "Shipped", "EnRoute"), "in_transit"),
            (("Packing", "Shipped", "EnRoute", "AvailablePickup"), "ready_for_pickup"),
            (("Packing", "Shipped", "EnRoute", "Delivered"), "delivered"),
            (("Packing", "Shipped", "EnRoute", "DeliveryFailed"), "delivery_failed"),
            (("Packing", "Shipped", "EnRoute", "Returned"), "return_to_sender"),
        ]:
            self.assertEqual(self._status_after(*codes), expected, codes)

    def test_pre_announced_collo_does_not_hide_the_order_feed(self):
        # DHL pre-announces the collo at label creation, so NotYetEnRoute sits
        # on the box from then on; it must not mask the order's own fate or a
        # carrier event that reaches the order feed first.
        for codes, expected in [
            (("Packing", "Shipped", "OrderDeleted"), "cancelled"),
            (("Packing", "Shipped", "Blocked"), "on_hold"),
            (("Packing", "Shipped", "EnRoute"), "in_transit"),
            (("Packing", "Shipped"), "pending"),
        ]:
            self.assertEqual(
                self._status_after(*codes, colli=PreAnnouncedColliResponse),
                expected,
                codes,
            )

    def test_mixed_colli_follow_the_box_the_carrier_has(self):
        self.assertEqual(
            self._status_after(
                "Packing", "Shipped", colli=self._colli("NotYetEnRoute", "EnRoute")
            ),
            "in_transit",
        )

    def test_unmapped_collo_code_leaves_warehouse_steps_pending(self):
        self.assertEqual(units.to_tracking_status("Registered"), "unknown")
        self.assertEqual(
            self._status_after("Packing", "Shipped", colli=self._colli("Registered")),
            "pending",
        )

    def test_warehouse_code_never_decides_whatever_its_text_says(self):
        # The keyword scan also reads the free text, by substring: INFORMATIE
        # holds RMA (return_to_sender), HOUSEHOLD holds HOLD (on_hold). A
        # warehouse step stays a warehouse step.
        for event in [
            ("Received", "Order received: 'Aanvullende informatie volgt'."),
            ("Picking", "Picking list printed: 'Household goods'."),
            ("Verified", "Order verified: 'Delivered to Monta by supplier'."),
        ]:
            self.assertEqual(self._status_after(event), "pending", event)


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

# Rebuilt from production trackers (read-only Karrio GraphQL, 2026-09-25):
# trk_78e76d43b588434c9e9a42314a4ff14a (SO-Shopify-06855, DPD) and
# trk_2af8b8b468e649a4b4f467cb21311b82 (SO-Shopify-06812, DHL). Codes and
# texts are verbatim; times match the trackers to the minute (Amsterdam wall
# clock, as Monta writes them), seconds are ours; T&T codes and postcode are
# replaced.

# SO-Shopify-06855 right after Pick & Print (2026-09-23 18:07 Amsterdam).
LabelOnlyEventsResponse = """[
    {"Id": 2, "WebshopOrderId": "SAL-ORD-2026-00001", "TypeCode": "Shipped",
     "Description": "Shipped (ready for shipper pickup): 'Shipping labels gemaakt via de REST api'.",
     "Occured": "2026-09-23T18:07:11.2", "Created": "2026-09-23T18:07:11.2"},
    {"Id": 1, "WebshopOrderId": "SAL-ORD-2026-00001", "TypeCode": "Packing",
     "Description": "Set to picked: ''Picked' automatically set when order is marked as shipped'.",
     "Occured": "2026-09-23T18:07:10.9", "Created": "2026-09-23T18:07:10.9"}
]
"""

LabelOnlyColliResponse = """{
    "TotalWeightInKg": 0, "PalletsShipped": 0, "BoxesShipped": 1,
    "ShippedPallets": {}, "ShippedBoxesOnPallets": [],
    "ShippedBoxesNotOnPallets": [
        {"DistinctProducts": 0, "TotalProducts": 0, "ShippedCarrierInfo": {
            "TTColloNr": 1, "PackageDescription": "Eigen verpakking product",
            "WeightInGrams": 3, "LengthInMM": 400, "WidthInMM": 300, "HeightInMM": 200,
            "TTCode": "05212000000001",
            "TTLink": "https://www.dpdgroup.com/nl/mydpd/my-parcels/search?lang=nl&parcelNumber=05212000000001",
            "DeliveryStatusDescription": null,
            "DeliveryStatusCode": null,
            "DeliveryStatusUpdatedAt": null}}
    ]
}
"""

# SO-Shopify-06855 that night: the first DPD scan in the sorting centre.
FirstScanEventsResponse = """[
    {"Id": 3, "WebshopOrderId": "SAL-ORD-2026-00001", "TypeCode": "EnRoute",
     "Description": "Delivery status changed to En route: status update from DPD (05212000000001): In transit (BetweenDepots)",
     "Occured": "2026-09-24T01:53:40.5", "Created": "2026-09-24T01:53:40.5"},
    {"Id": 2, "WebshopOrderId": "SAL-ORD-2026-00001", "TypeCode": "Shipped",
     "Description": "Shipped (ready for shipper pickup): 'Shipping labels gemaakt via de REST api'.",
     "Occured": "2026-09-23T18:07:11.2", "Created": "2026-09-23T18:07:11.2"},
    {"Id": 1, "WebshopOrderId": "SAL-ORD-2026-00001", "TypeCode": "Packing",
     "Description": "Set to picked: ''Picked' automatically set when order is marked as shipped'.",
     "Occured": "2026-09-23T18:07:10.9", "Created": "2026-09-23T18:07:10.9"}
]
"""

FirstScanColliResponse = """{
    "TotalWeightInKg": 0, "PalletsShipped": 0, "BoxesShipped": 1,
    "ShippedPallets": {}, "ShippedBoxesOnPallets": [],
    "ShippedBoxesNotOnPallets": [
        {"DistinctProducts": 0, "TotalProducts": 0, "ShippedCarrierInfo": {
            "TTColloNr": 1, "PackageDescription": "Eigen verpakking product",
            "WeightInGrams": 3, "LengthInMM": 400, "WidthInMM": 300, "HeightInMM": 200,
            "TTCode": "05212000000001",
            "TTLink": "https://www.dpdgroup.com/nl/mydpd/my-parcels/search?lang=nl&parcelNumber=05212000000001",
            "DeliveryStatusDescription": "In distributie (gesorteerd in sorteercentrum) / onderweg",
            "DeliveryStatusCode": "EnRoute",
            "DeliveryStatusUpdatedAt": "24-9-2026 0:34:18"}}
    ]
}
"""

# SO-Shopify-06812 right after Pick & Print (2026-09-22): DHL pre-announced.
PreAnnouncedEventsResponse = """[
    {"Id": 4, "WebshopOrderId": "SAL-ORD-2026-00001", "TypeCode": "Shipped",
     "Description": "Shipped (ready for shipper pickup): 'Shipping labels gemaakt via de REST api'.",
     "Occured": "2026-09-22T18:07:04.6", "Created": "2026-09-22T18:07:04.6"},
    {"Id": 3, "WebshopOrderId": "SAL-ORD-2026-00001", "TypeCode": "Packing",
     "Description": "Set to picked: ''Picked' automatically set when order is marked as shipped'.",
     "Occured": "2026-09-22T18:07:04.3", "Created": "2026-09-22T18:07:04.3"},
    {"Id": 2, "WebshopOrderId": "SAL-ORD-2026-00001", "TypeCode": "Unblocked",
     "Description": "Order unblocked: 'UBlock tbv update via MontaRESTApi verwijderd'.",
     "Occured": "2026-09-22T17:15:09.4", "Created": "2026-09-22T17:15:09.4"},
    {"Id": 1, "WebshopOrderId": "SAL-ORD-2026-00001", "TypeCode": "Blocked",
     "Description": "Order blocked: 'Blocked because there was an update in de MontaRESTApi'.",
     "Occured": "2026-09-22T17:15:08.2", "Created": "2026-09-22T17:15:08.2"}
]
"""

PreAnnouncedColliResponse = """{
    "TotalWeightInKg": 0, "PalletsShipped": 0, "BoxesShipped": 1,
    "ShippedPallets": {}, "ShippedBoxesOnPallets": [],
    "ShippedBoxesNotOnPallets": [
        {"DistinctProducts": 0, "TotalProducts": 0, "ShippedCarrierInfo": {
            "TTColloNr": 1, "PackageDescription": "Eigen verpakking product",
            "WeightInGrams": 3, "LengthInMM": 400, "WidthInMM": 300, "HeightInMM": 200,
            "TTCode": "JVGL06212989000000000001",
            "TTLink": "https://my.dhlecommerce.nl/home/tracktrace/JVGL06212989000000000001/1234AB?lang=nl_NL",
            "DeliveryStatusDescription": "Voorgemeld bij verzender, nog niet in distributie",
            "DeliveryStatusCode": "NotYetEnRoute",
            "DeliveryStatusUpdatedAt": "22-9-2026 16:07:02"}}
    ]
}
"""

# Rebuilt from SO-Shopify-06412 (GLS, two colli; read-only Monta GET /events
# and /colli + Karrio tracker trk_cabd6d297f284189905bc324d3102175,
# 2026-09-25). Codes and texts are verbatim, and so are the times (the
# pre-announcement to the minute, seconds are ours); T&T codes and postcode
# are replaced. The GLS order event of 2026-09-14 09:53 Amsterdam, on its own.
ExpectedTodayEventsResponse = """[
    {"Id": 1, "WebshopOrderId": "SAL-ORD-2026-00001", "TypeCode": "EnRoute",
     "Description": "Delivery status changed to En route: status update from GLS (00XX0001): The parcel is expected to be delivered during the day. (11)",
     "Occured": "2026-09-14T09:53:16.31", "Created": "2026-09-14T09:53:16.31"}
]
"""

# The two GLS boxes registered at label creation, no carrier status yet.
GlsRegisteredColliResponse = """{
    "TotalWeightInKg": 9, "PalletsShipped": 0, "BoxesShipped": 2,
    "ShippedPallets": {}, "ShippedBoxesOnPallets": [],
    "ShippedBoxesNotOnPallets": [
        {"DistinctProducts": 0, "TotalProducts": 0, "ShippedCarrierInfo": {
            "TTColloNr": 1, "PackageDescription": "Eigen verpakking product",
            "WeightInGrams": 4800, "LengthInMM": 440, "WidthInMM": 340, "HeightInMM": 220,
            "TTCode": "00XX0001",
            "TTLink": "https://www.gls-info.nl/Tracking?parcelNo=00XX0001&zipcode=1234AB&lang=NL",
            "DeliveryStatusDescription": null,
            "DeliveryStatusCode": null,
            "DeliveryStatusUpdatedAt": null}},
        {"DistinctProducts": 0, "TotalProducts": 0, "ShippedCarrierInfo": {
            "TTColloNr": 2, "PackageDescription": "Eigen verpakking product",
            "WeightInGrams": 4800, "LengthInMM": 440, "WidthInMM": 340, "HeightInMM": 220,
            "TTCode": "00XX0002",
            "TTLink": "https://www.gls-info.nl/Tracking?parcelNo=00XX0002&zipcode=1234AB&lang=NL",
            "DeliveryStatusDescription": null,
            "DeliveryStatusCode": null,
            "DeliveryStatusUpdatedAt": null}}
    ]
}
"""

# The same two boxes as GLS pre-announced them on 2026-09-10.
GlsPreAnnouncedColliResponse = """{
    "TotalWeightInKg": 9, "PalletsShipped": 0, "BoxesShipped": 2,
    "ShippedPallets": {}, "ShippedBoxesOnPallets": [],
    "ShippedBoxesNotOnPallets": [
        {"DistinctProducts": 0, "TotalProducts": 0, "ShippedCarrierInfo": {
            "TTColloNr": 1, "PackageDescription": "Eigen verpakking product",
            "WeightInGrams": 4800, "LengthInMM": 440, "WidthInMM": 340, "HeightInMM": 220,
            "TTCode": "00XX0001",
            "TTLink": "https://www.gls-info.nl/Tracking?parcelNo=00XX0001&zipcode=1234AB&lang=NL",
            "DeliveryStatusDescription": "Voorgemeld bij verzender, nog niet in distributie",
            "DeliveryStatusCode": "NotYetEnRoute",
            "DeliveryStatusUpdatedAt": "10-9-2026 13:25:56"}},
        {"DistinctProducts": 0, "TotalProducts": 0, "ShippedCarrierInfo": {
            "TTColloNr": 2, "PackageDescription": "Eigen verpakking product",
            "WeightInGrams": 4800, "LengthInMM": 440, "WidthInMM": 340, "HeightInMM": 220,
            "TTCode": "00XX0002",
            "TTLink": "https://www.gls-info.nl/Tracking?parcelNo=00XX0002&zipcode=1234AB&lang=NL",
            "DeliveryStatusDescription": "Voorgemeld bij verzender, nog niet in distributie",
            "DeliveryStatusCode": "NotYetEnRoute",
            "DeliveryStatusUpdatedAt": "10-9-2026 13:25:56"}}
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
                    "status": "picked_up",
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
