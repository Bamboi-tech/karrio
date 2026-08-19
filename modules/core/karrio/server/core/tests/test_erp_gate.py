"""Bamboi fork: the ERP label gate must run on every purchase of an
ERP-linked shipment and fail closed when ERP cannot answer; standalone
shipments never touch the ERP. See karrio.server.core.erp_gate."""

import requests
from unittest import mock

from django.test import TestCase, override_settings

from karrio.server.core import erp_gate
from karrio.server.core.exceptions import APIException


def _shipment(metadata=None):
    shipment = mock.MagicMock()
    shipment.id = "shp_test123"
    shipment.metadata = metadata or {}
    return shipment


ERP_META = {"karrio_shipment": "KAR-SHIP-2026-00001", "sales_order": "SO-Shopify-00001"}


def _response(status_code=200, payload=None):
    response = mock.MagicMock()
    response.status_code = status_code
    response.json.return_value = payload or {}
    if status_code >= 400:
        response.raise_for_status.side_effect = requests.HTTPError(response=response)
    return response


@override_settings(ERP_GATE_URL="https://erp.test", ERP_GATE_TOKEN="key:secret")
class TestLabelGate(TestCase):
    def test_standalone_shipment_never_calls_erp(self):
        with mock.patch.object(erp_gate.requests, "post") as post:
            erp_gate.assert_erp_label_allowed(_shipment())
        post.assert_not_called()

    def test_allowed_purchase_passes(self):
        with mock.patch.object(
            erp_gate.requests,
            "post",
            return_value=_response(payload={"message": {"allowed": True}}),
        ) as post:
            erp_gate.assert_erp_label_allowed(_shipment(ERP_META))
        _args, kwargs = post.call_args
        self.assertEqual(kwargs["json"]["karrio_shipment"], ERP_META["karrio_shipment"])
        self.assertEqual(kwargs["headers"]["Authorization"], "token key:secret")

    def test_refusal_surfaces_erp_reason(self):
        reason = "Order SO-Shopify-00001 is on_hold in Shopify — release it there before it may ship."
        with mock.patch.object(
            erp_gate.requests,
            "post",
            return_value=_response(
                payload={"message": {"allowed": False, "reason": reason}}
            ),
        ):
            with self.assertRaises(APIException) as caught:
                erp_gate.assert_erp_label_allowed(_shipment(ERP_META))
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("on_hold", str(caught.exception.detail))

    def test_erp_unreachable_fails_closed(self):
        with mock.patch.object(
            erp_gate.requests, "post", side_effect=requests.ConnectionError("down")
        ):
            with self.assertRaises(APIException) as caught:
                erp_gate.assert_erp_label_allowed(_shipment(ERP_META))
        self.assertEqual(caught.exception.status_code, 424)

    def test_erp_http_error_fails_closed(self):
        with mock.patch.object(erp_gate.requests, "post", return_value=_response(500)):
            with self.assertRaises(APIException) as caught:
                erp_gate.assert_erp_label_allowed(_shipment(ERP_META))
        self.assertEqual(caught.exception.status_code, 424)

    @override_settings(ERP_GATE_URL=None, ERP_GATE_TOKEN=None)
    def test_unconfigured_gate_fails_closed_for_linked_shipments(self):
        with self.assertRaises(APIException) as caught:
            erp_gate.assert_erp_label_allowed(_shipment(ERP_META))
        self.assertEqual(caught.exception.status_code, 424)


@override_settings(ERP_GATE_URL="https://erp.test", ERP_GATE_TOKEN="key:secret")
class TestShipmentActionRelay(TestCase):
    def test_unknown_action_is_rejected(self):
        with self.assertRaises(APIException) as caught:
            erp_gate.run_erp_shipment_action(_shipment(ERP_META), "delete")
        self.assertEqual(caught.exception.status_code, 400)

    def test_unlinked_shipment_is_rejected(self):
        with self.assertRaises(APIException) as caught:
            erp_gate.run_erp_shipment_action(_shipment(), "mark_picked")
        self.assertEqual(caught.exception.status_code, 409)

    def test_success_returns_erp_message(self):
        message = "Marked picked. Nothing has been reported to Shopify."
        with mock.patch.object(
            erp_gate.requests,
            "post",
            return_value=_response(payload={"message": message}),
        ) as post:
            result = erp_gate.run_erp_shipment_action(
                _shipment(ERP_META), "mark_picked"
            )
        self.assertEqual(result, {"message": message})
        _args, kwargs = post.call_args
        self.assertEqual(
            kwargs["json"],
            {
                "dt": "Karrio Shipment",
                "dn": ERP_META["karrio_shipment"],
                "method": "mark_picked",
            },
        )

    def test_mark_shipped_is_relayed(self):
        message = "Marked shipped. The order is now In Transit."
        with mock.patch.object(
            erp_gate.requests,
            "post",
            return_value=_response(payload={"message": message}),
        ) as post:
            result = erp_gate.run_erp_shipment_action(
                _shipment(ERP_META), "mark_shipped"
            )
        self.assertEqual(result, {"message": message})
        _args, kwargs = post.call_args
        self.assertEqual(
            kwargs["json"],
            {
                "dt": "Karrio Shipment",
                "dn": ERP_META["karrio_shipment"],
                "method": "mark_shipped",
            },
        )

    def test_erp_refusal_surfaces_server_message(self):
        body = {
            "exception": "frappe.exceptions.ValidationError: held",
            "_server_messages": '["{\\"message\\": \\"Order <b>SO-1</b> is on_hold in Shopify.\\"}"]',
        }
        with mock.patch.object(
            erp_gate.requests, "post", return_value=_response(417, payload=body)
        ):
            with self.assertRaises(APIException) as caught:
                erp_gate.run_erp_shipment_action(_shipment(ERP_META), "mark_picked")
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("SO-1 is on_hold", str(caught.exception.detail))

    def test_erp_unreachable_fails_closed(self):
        with mock.patch.object(
            erp_gate.requests, "post", side_effect=requests.Timeout("slow")
        ):
            with self.assertRaises(APIException) as caught:
                erp_gate.run_erp_shipment_action(
                    _shipment(ERP_META), "mark_out_for_delivery"
                )
        self.assertEqual(caught.exception.status_code, 424)
