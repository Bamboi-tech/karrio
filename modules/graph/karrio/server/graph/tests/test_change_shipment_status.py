"""Bamboi fork: a tracked shipment's status belongs to the carrier — an
operator may override it, but only with a reason, and the override is
audited onto shipment.metadata["status_override"]."""

from karrio.server.graph.tests.base import GraphTestCase
import karrio.server.manager.models as manager
import karrio.server.tracing.models  # noqa: F401  (app registry)


MUTATION = """
mutation change_shipment_status($data: ChangeShipmentStatusMutationInput!) {
  change_shipment_status(input: $data) {
    shipment { id status metadata }
    errors { field messages }
  }
}
"""


class TestChangeShipmentStatus(GraphTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.shipment = manager.Shipment.objects.create(
            created_by=self.user,
            status="in_transit",
            test_mode=False,
            payment={"currency": "EUR", "paid_by": "sender"},
            metadata={"sales_order": "SO-TEST"},
        )

    def _tracker(self):
        import karrio.server.manager.models as models

        return models.Tracking.objects.create(
            created_by=self.user,
            tracking_number="TRK123",
            test_mode=False,
            shipment=self.shipment,
            status="in_transit",
        )

    def _mutate(self, **data):
        return self.query(
            MUTATION,
            operation_name="change_shipment_status",
            variables={"data": {"id": self.shipment.id, **data}},
        )

    def test_untracked_shipment_needs_no_reason(self):
        response = self._mutate(status="delivered")
        self.assertResponseNoErrors(response)
        self.shipment.refresh_from_db()
        self.assertEqual(self.shipment.status, "delivered")
        # No override happened, so no audit record is written.
        self.assertNotIn("status_override", self.shipment.metadata or {})

    def test_tracked_shipment_without_reason_is_refused(self):
        self._tracker()
        response = self._mutate(status="delivered")
        self.assertIn("requires a reason", str(response.data))
        self.shipment.refresh_from_db()
        self.assertEqual(self.shipment.status, "in_transit")

    def test_tracked_shipment_with_reason_is_audited(self):
        self._tracker()
        response = self._mutate(
            status="delivery_failed", reason="Doos kwam retour aan de balie"
        )
        self.assertResponseNoErrors(response)
        self.shipment.refresh_from_db()
        self.assertEqual(self.shipment.status, "delivery_failed")
        override = (self.shipment.metadata or {}).get("status_override")
        self.assertIsNotNone(override)
        self.assertEqual(override["reason"], "Doos kwam retour aan de balie")
        self.assertEqual(override["status"], "delivery_failed")
        self.assertTrue(override["by"])
        self.assertTrue(override["at"])
        # The pre-existing metadata survives the audit write.
        self.assertEqual(self.shipment.metadata["sales_order"], "SO-TEST")

    def test_a_blank_reason_does_not_count(self):
        self._tracker()
        response = self._mutate(status="delivered", reason="   ")
        self.assertIn("requires a reason", str(response.data))
