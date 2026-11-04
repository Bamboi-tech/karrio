"""The HTTP error contract preserves trusted pre-purchase evidence as a boolean."""

from django.test import SimpleTestCase

from karrio.core.models import Message
from karrio.server.core.exceptions import APIException, message_handler


class TestMontaRetryMarker(SimpleTestCase):
    def test_424_response_preserves_typed_carrier_evidence(self):
        error = APIException(
            detail=[
                Message(
                    carrier_name="monta",
                    carrier_id="monta",
                    code="42",
                    message="Not yet verified",
                    details={"monta_purchase_not_attempted": True},
                )
            ],
            status_code=424,
        )
        response = message_handler(error)
        self.assertEqual(error.status_code, 424)
        self.assertDictEqual(
            response["messages"][0]["details"], {"monta_purchase_not_attempted": True}
        )
        self.assertEqual(response["messages"][0]["code"], "42")
        self.assertEqual(response["messages"][0]["carrier_name"], "monta")


class TestDashboardReservationRejection(SimpleTestCase):
    def error(self, marker=True, code="42"):
        return APIException(
            detail=[
                Message(
                    carrier_name="monta",
                    carrier_id="monta",
                    code=code,
                    message="Not verified",
                    details={"monta_purchase_not_attempted": marker},
                )
            ],
            status_code=424,
        )

    def test_only_proven_refusal_releases_exact_dashboard_operation(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from karrio.server.core.erp_gate import reject_unattempted_label

        shipment = SimpleNamespace(
            id="shp_current", metadata={"karrio_shipment": "forged"}
        )
        with self.settings(ERP_GATE_URL="https://erp.invalid", ERP_GATE_TOKEN="test"):
            with patch("karrio.server.core.erp_gate.requests.post") as post:
                reject_unattempted_label(shipment, "operation-1", self.error())
        self.assertEqual(
            post.call_args.kwargs["json"],
            {
                "karrio_shipment_id": "shp_current",
                "operation_id": "operation-1",
            },
        )

    def test_unknown_post_purchase_and_erp_owned_operations_never_release(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from karrio.server.core.erp_gate import reject_unattempted_label

        shipment = SimpleNamespace(id="shp_current")
        cases = [
            ("op", self.error(False)),
            ("op", self.error("true")),
            ("op", self.error(True, "500")),
            (None, self.error()),
            ("op", APIException(detail="unknown", status_code=424)),
        ]
        with patch("karrio.server.core.erp_gate.requests.post") as post:
            for operation, error in cases:
                reject_unattempted_label(shipment, operation, error)
        post.assert_not_called()

    def test_callback_failure_preserves_original_carrier_refusal(self):
        from types import SimpleNamespace
        from unittest.mock import patch, Mock
        import requests
        from karrio.server.manager.serializers import shipment as module

        shipment = SimpleNamespace(id="shp_current", metadata={}, options={})
        carrier = SimpleNamespace(carrier_id="monta", capabilities=[])
        error = self.error()
        with (
            self.settings(ERP_GATE_URL="https://erp.invalid", ERP_GATE_TOKEN="test"),
            patch(
                "karrio.server.core.erp_gate.assert_erp_label_allowed",
                return_value="operation-1",
            ),
            patch(
                "karrio.server.core.erp_gate.requests.post",
                side_effect=requests.Timeout,
            ) as post,
            patch.object(module, "Shipment", return_value=SimpleNamespace(data={})),
            patch.object(
                module.ShipmentPurchaseSerializer,
                "map",
                return_value=SimpleNamespace(save=Mock(side_effect=error)),
            ),
        ):
            with self.assertRaises(APIException) as caught:
                module.buy_shipment_label(
                    shipment, selected_rate={"carrier_id": "monta"}, carriers=[carrier]
                )
        self.assertIs(caught.exception, error)
        post.assert_called_once()
