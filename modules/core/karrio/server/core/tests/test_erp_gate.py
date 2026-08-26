"""Bamboi fork: the ERP label gate must run on every purchase of an
ERP-linked shipment and fail closed when ERP cannot answer; standalone
shipments never touch the ERP. See karrio.server.core.erp_gate."""

import json
import requests
from unittest import mock

from django.test import TestCase, override_settings
from django.utils.translation import gettext_lazy

from karrio.server.core import erp_gate, exceptions
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

    def test_cancel_shipment_is_relayed(self):
        message = "Shipment cancelled."
        with mock.patch.object(
            erp_gate.requests,
            "post",
            return_value=_response(payload={"message": message}),
        ) as post:
            result = erp_gate.run_erp_shipment_action(
                _shipment(ERP_META), "cancel_shipment"
            )
        self.assertEqual(result, {"message": message})
        _args, kwargs = post.call_args
        self.assertEqual(
            kwargs["json"],
            {
                "dt": "Karrio Shipment",
                "dn": ERP_META["karrio_shipment"],
                "method": "cancel_shipment",
            },
        )

    def test_action_arguments_are_forwarded_to_frappe(self):
        with mock.patch.object(
            erp_gate.requests,
            "post",
            return_value=_response(payload={"message": "Outcome recorded."}),
        ) as post:
            erp_gate.run_erp_shipment_action(
                _shipment(ERP_META),
                "record_delivery_outcome",
                args={"outcome": "delivered", "note": "left with neighbour"},
            )
        _args, kwargs = post.call_args
        self.assertEqual(
            kwargs["json"],
            {
                "dt": "Karrio Shipment",
                "dn": ERP_META["karrio_shipment"],
                "method": "record_delivery_outcome",
                # frappe.handler.run_doc_method splats this into kwargs.
                "args": {"outcome": "delivered", "note": "left with neighbour"},
            },
        )

    def test_optional_arguments_may_be_omitted(self):
        with mock.patch.object(
            erp_gate.requests,
            "post",
            return_value=_response(payload={"message": "Outcome recorded."}),
        ) as post:
            erp_gate.run_erp_shipment_action(
                _shipment(ERP_META),
                "record_delivery_outcome",
                args={"outcome": "refused"},
            )
        _args, kwargs = post.call_args
        self.assertEqual(kwargs["json"]["args"], {"outcome": "refused"})

    def test_unexpected_argument_is_rejected(self):
        with mock.patch.object(erp_gate.requests, "post") as post:
            with self.assertRaises(APIException) as caught:
                erp_gate.run_erp_shipment_action(
                    _shipment(ERP_META),
                    "record_delivery_outcome",
                    args={"outcome": "delivered", "docstatus": 2},
                )
        post.assert_not_called()
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("docstatus", str(caught.exception.detail))

    def test_parameterless_action_accepts_no_arguments(self):
        with mock.patch.object(erp_gate.requests, "post") as post:
            with self.assertRaises(APIException) as caught:
                erp_gate.run_erp_shipment_action(
                    _shipment(ERP_META), "mark_picked", args={"outcome": "delivered"}
                )
        post.assert_not_called()
        self.assertEqual(caught.exception.status_code, 400)

    def test_undo_actions_are_whitelisted(self):
        for action in (
            "unmark_shipped",
            "unmark_out_for_delivery",
            "unmark_delivered",
            "undo_delivery_outcome",
            "confirm_address",
        ):
            with self.subTest(action=action):
                with mock.patch.object(
                    erp_gate.requests,
                    "post",
                    return_value=_response(payload={"message": "Done."}),
                ) as post:
                    result = erp_gate.run_erp_shipment_action(
                        _shipment(ERP_META), action
                    )
                self.assertEqual(result, {"message": "Done."})
                _args, kwargs = post.call_args
                self.assertEqual(
                    kwargs["json"],
                    {
                        "dt": "Karrio Shipment",
                        "dn": ERP_META["karrio_shipment"],
                        "method": action,
                    },
                )

    def test_dashboard_spellings_resolve_to_whitelisted_actions(self):
        """The route translates kebab-case; every dashboard spelling must land
        on a whitelisted snake_case action."""
        for spelling in (
            "unmark-shipped",
            "unmark-out-for-delivery",
            "mark-delivered",
            "unmark-delivered",
            "undo-delivery-outcome",
        ):
            with self.subTest(spelling=spelling):
                self.assertIn(spelling.replace("-", "_"), erp_gate.ERP_SHIPMENT_ACTIONS)

    def test_undo_actions_accept_no_arguments(self):
        for action in (
            "unmark_shipped",
            "unmark_out_for_delivery",
            "unmark_delivered",
            "undo_delivery_outcome",
            "confirm_address",
        ):
            with self.subTest(action=action):
                with mock.patch.object(erp_gate.requests, "post") as post:
                    with self.assertRaises(APIException) as caught:
                        erp_gate.run_erp_shipment_action(
                            _shipment(ERP_META), action, args={"note": "x"}
                        )
                post.assert_not_called()
                self.assertEqual(caught.exception.status_code, 400)

    def test_non_object_arguments_are_rejected(self):
        with mock.patch.object(erp_gate.requests, "post") as post:
            with self.assertRaises(APIException) as caught:
                erp_gate.run_erp_shipment_action(
                    _shipment(ERP_META), "record_delivery_outcome", args=["delivered"]
                )
        post.assert_not_called()
        self.assertEqual(caught.exception.status_code, 400)


@override_settings(ERP_GATE_URL="https://erp.test", ERP_GATE_TOKEN="key:secret")
class TestFeaturesRelay(TestCase):
    def test_list_unwraps_frappe_message(self):
        payload = {"message": {"features": [{"key": "auto_labels", "enabled": True}]}}
        with mock.patch.object(
            erp_gate.requests, "post", return_value=_response(payload=payload)
        ) as post:
            result = erp_gate.run_erp_features_list()
        self.assertEqual(
            result, {"features": [{"key": "auto_labels", "enabled": True}]}
        )
        args, kwargs = post.call_args
        self.assertTrue(args[0].endswith(erp_gate.FEATURES_LIST_PATH))
        self.assertEqual(kwargs["headers"]["Authorization"], "token key:secret")

    def test_set_relays_key_and_enabled(self):
        payload = {"message": {"key": "auto_labels", "enabled": False}}
        with mock.patch.object(
            erp_gate.requests, "post", return_value=_response(payload=payload)
        ) as post:
            result = erp_gate.run_erp_features_set("auto_labels", False)
        self.assertEqual(result, {"key": "auto_labels", "enabled": False})
        args, kwargs = post.call_args
        self.assertTrue(args[0].endswith(erp_gate.FEATURES_SET_PATH))
        self.assertEqual(kwargs["json"], {"key": "auto_labels", "enabled": False})

    def test_malformed_payload_never_reaches_erp(self):
        for key, enabled in (
            (None, True),
            ("", True),
            (5, True),
            ("auto_labels", "yes"),
            ("auto_labels", None),
        ):
            with self.subTest(key=key, enabled=enabled):
                with mock.patch.object(erp_gate.requests, "post") as post:
                    with self.assertRaises(APIException) as caught:
                        erp_gate.run_erp_features_set(key, enabled)
                post.assert_not_called()
                self.assertEqual(caught.exception.status_code, 400)

    def test_unknown_key_surfaces_erp_refusal(self):
        body = {
            "exception": "frappe.exceptions.ValidationError: unknown flag",
            "_server_messages": '["{\\"message\\": \\"Unknown feature flag <b>no_such_flag</b>.\\"}"]',
        }
        with mock.patch.object(
            erp_gate.requests, "post", return_value=_response(417, payload=body)
        ):
            with self.assertRaises(APIException) as caught:
                erp_gate.run_erp_features_set("no_such_flag", True)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn("Unknown feature flag no_such_flag", str(caught.exception.detail))

    def test_list_erp_error_surfaces_as_conflict(self):
        with mock.patch.object(
            erp_gate.requests, "post", return_value=_response(500, payload={})
        ):
            with self.assertRaises(APIException) as caught:
                erp_gate.run_erp_features_list()
        self.assertEqual(caught.exception.status_code, 409)

    def test_unreachable_fails_closed(self):
        with mock.patch.object(
            erp_gate.requests, "post", side_effect=requests.ConnectionError("down")
        ):
            with self.assertRaises(APIException) as caught:
                erp_gate.run_erp_features_list()
        self.assertEqual(caught.exception.status_code, 424)
        with mock.patch.object(
            erp_gate.requests, "post", side_effect=requests.Timeout("slow")
        ):
            with self.assertRaises(APIException) as caught:
                erp_gate.run_erp_features_set("auto_labels", True)
        self.assertEqual(caught.exception.status_code, 424)

    @override_settings(ERP_GATE_URL=None, ERP_GATE_TOKEN=None)
    def test_unconfigured_fails_closed(self):
        with self.assertRaises(APIException) as caught:
            erp_gate.run_erp_features_list()
        self.assertEqual(caught.exception.status_code, 424)
        with self.assertRaises(APIException) as caught:
            erp_gate.run_erp_features_set("auto_labels", True)
        self.assertEqual(caught.exception.status_code, 424)


@override_settings(ERP_GATE_URL="https://erp.test", ERP_GATE_TOKEN="key:secret")
class TestRefusalDetailIsSerializable(TestCase):
    """Regression: every erp_gate refusal must carry a plain ``str`` detail.

    ``gettext_lazy`` returns a proxy that is not a ``str``, so the exception
    handler files it under ``details`` instead of ``message`` and
    ``lib.to_dict`` serializes it as ``{"_args": [...], "_kw": {}}``. That
    object reached the API log and the dashboard rendered it as a React
    child, blanking the page with "Something went wrong!".
    """

    def _refusals(self):
        """Every APIException erp_gate can raise, paired with a label."""
        refusals = []

        def collect(label, call):
            try:
                call()
            except APIException as error:
                refusals.append((label, error))
            else:  # pragma: no cover - the calls below always raise
                self.fail(f"{label} did not raise")

        collect(
            "label gate blocked",
            lambda: self._with_post(
                mock.MagicMock(
                    return_value=_response(payload={"message": {"allowed": False}})
                ),
                lambda: erp_gate.assert_erp_label_allowed(_shipment(ERP_META)),
            ),
        )
        collect(
            "label gate unreachable",
            lambda: self._with_post(
                mock.MagicMock(side_effect=requests.ConnectionError("down")),
                lambda: erp_gate.assert_erp_label_allowed(_shipment(ERP_META)),
            ),
        )
        collect(
            "action unknown",
            lambda: erp_gate.run_erp_shipment_action(_shipment(ERP_META), "delete"),
        )
        collect(
            "action unlinked",
            lambda: erp_gate.run_erp_shipment_action(_shipment(), "mark_picked"),
        )
        collect(
            "action invalid args",
            lambda: erp_gate.run_erp_shipment_action(
                _shipment(ERP_META), "mark_picked", args={"outcome": "delivered"}
            ),
        )
        collect(
            "action refused without a server message",
            lambda: self._with_post(
                mock.MagicMock(return_value=_response(417, payload={})),
                lambda: erp_gate.run_erp_shipment_action(
                    _shipment(ERP_META), "mark_picked"
                ),
            ),
        )
        collect(
            "action unreachable",
            lambda: self._with_post(
                mock.MagicMock(side_effect=requests.Timeout("slow")),
                lambda: erp_gate.run_erp_shipment_action(
                    _shipment(ERP_META), "mark_picked"
                ),
            ),
        )

        collect(
            "feature payload invalid",
            lambda: erp_gate.run_erp_features_set("auto_labels", "yes"),
        )
        collect(
            "feature refused without a server message",
            lambda: self._with_post(
                mock.MagicMock(return_value=_response(417, payload={})),
                lambda: erp_gate.run_erp_features_set("auto_labels", True),
            ),
        )
        collect(
            "features unreachable",
            lambda: self._with_post(
                mock.MagicMock(side_effect=requests.Timeout("slow")),
                lambda: erp_gate.run_erp_features_list(),
            ),
        )

        with override_settings(ERP_GATE_URL=None, ERP_GATE_TOKEN=None):
            collect(
                "label gate unconfigured",
                lambda: erp_gate.assert_erp_label_allowed(_shipment(ERP_META)),
            )
            collect(
                "action unconfigured",
                lambda: erp_gate.run_erp_shipment_action(
                    _shipment(ERP_META), "mark_picked"
                ),
            )
            collect(
                "features unconfigured",
                lambda: erp_gate.run_erp_features_list(),
            )

        return refusals

    @staticmethod
    def _with_post(post, call):
        with mock.patch.object(erp_gate.requests, "post", post):
            return call()

    def test_every_refusal_detail_is_a_plain_string(self):
        for label, error in self._refusals():
            with self.subTest(refusal=label):
                self.assertIsInstance(error.detail, str)

    def test_every_refusal_serializes_as_text_not_as_a_lazy_proxy(self):
        for label, error in self._refusals():
            with self.subTest(refusal=label):
                response = exceptions.custom_exception_handler(error, {})
                payload = json.dumps(response.data)
                self.assertNotIn('"_args"', payload)
                self.assertNotIn('"_kw"', payload)
                message = response.data["errors"][0]["message"]
                self.assertIsInstance(message, str)
                self.assertTrue(message)
                # A non-str detail would land here instead of in ``message``.
                self.assertIsNone(response.data["errors"][0].get("details"))

    def test_a_lazy_detail_would_still_break_serialization(self):
        """Guards the two assertions above against becoming vacuous."""
        lazy = gettext_lazy("ERP refused the action.")
        response = exceptions.custom_exception_handler(
            APIException(lazy, code="erp_action_refused", status_code=409), {}
        )
        self.assertIn('"_args"', json.dumps(response.data))
