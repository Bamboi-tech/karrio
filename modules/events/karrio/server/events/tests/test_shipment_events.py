"""Bamboi fork: a shipment that reaches ``delivered`` must emit an event.

Karrio emitted every other shipment status transition but nothing at all for
``delivered``, so a shipment marked delivered in the dashboard never reached
a subscriber (and therefore never reached the ERP).
"""

from unittest.mock import patch

from karrio.server.core.tests import APITestCase
from karrio.server.events.serializers import EventTypes
import karrio.server.manager.models as models


class TestShipmentStatusEvents(APITestCase):
    def setUp(self) -> None:
        super().setUp()
        self.shipment = models.Shipment.objects.create(
            shipper={
                "postal_code": "E1C4Z8",
                "city": "Moncton",
                "person_name": "John Doe",
                "company_name": "A corp.",
                "country_code": "CA",
                "phone_number": "514 000 0000",
                "state_code": "NB",
                "address_line1": "125 Church St",
            },
            recipient={
                "postal_code": "V6M2V9",
                "city": "Vancouver",
                "person_name": "Jane Doe",
                "company_name": "B corp.",
                "country_code": "CA",
                "phone_number": "604 000 0000",
                "state_code": "BC",
                "address_line1": "5840 Oak St",
            },
            parcels=[
                {
                    "weight": 1.0,
                    "weight_unit": "KG",
                    "package_preset": "canadapost_corrugated_small_box",
                }
            ],
            created_by=self.user,
            test_mode=True,
            status="in_transit",
            tracking_number="123456789012",
        )

    def _save_status(self, status: str):
        with patch("karrio.server.events.tasks.notify_webhooks") as notify:
            self.shipment.status = status
            self.shipment.save(update_fields=["status"])
        return notify

    def test_delivered_status_emits_shipment_delivered(self):
        notify = self._save_status("delivered")

        notify.assert_called_once()
        event, *_ = notify.call_args[0]
        self.assertEqual(event, EventTypes.shipment_delivered.value)

    def test_out_for_delivery_still_emits_its_own_event(self):
        notify = self._save_status("out_for_delivery")

        notify.assert_called_once()
        event, *_ = notify.call_args[0]
        self.assertEqual(event, EventTypes.shipment_out_for_delivery.value)

    def test_unrelated_save_emits_nothing(self):
        with patch("karrio.server.events.tasks.notify_webhooks") as notify:
            self.shipment.reference = "SO-Shopify-00001"
            self.shipment.save(update_fields=["reference"])

        notify.assert_not_called()
