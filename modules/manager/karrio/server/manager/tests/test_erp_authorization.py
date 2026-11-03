"""ERP links and global safety controls cannot be changed by ordinary callers."""

import copy
from types import SimpleNamespace
from unittest.mock import patch, Mock

from django.test import SimpleTestCase, override_settings
from django.urls import reverse

from karrio.server.core.erp_gate import (
    assert_erp_feature_manager,
    assert_erp_metadata_write,
    assert_erp_label_allowed,
    assert_erp_organization,
)
from karrio.server.core.exceptions import APIException
from karrio.server.manager.tests.test_shipments import (
    TestShipmentFixture,
    SHIPMENT_DATA,
)


@override_settings(MULTI_ORGANIZATIONS=False, ERP_INTEGRATION_USER_ID=None)
class TestERPProtectedMetadata(TestShipmentFixture):
    def setUp(self):
        super().setUp()
        self.link = {"karrio_shipment": "ERP-SHIPMENT-1", "sales_order": "SO-1"}
        self.shipment.metadata = self.link
        self.shipment.save()
        self.url = reverse(
            "karrio.server.manager:shipment-details", kwargs={"pk": self.shipment.pk}
        )

    def test_rest_cannot_remove_or_retarget_link(self):
        for metadata in (
            {"karrio_shipment": None, "sales_order": None},
            {"karrio_shipment": "ERP-SHIPMENT-OTHER"},
        ):
            with self.subTest(metadata=metadata):
                response = self.client.put(
                    self.url, {"metadata": metadata}, format="json"
                )
                self.assertEqual(response.status_code, 403)
                self.shipment.refresh_from_db()
                self.assertDictEqual(self.shipment.metadata, self.link)

    def test_unrelated_metadata_remains_editable(self):
        response = self.client.put(
            self.url, {"metadata": {"note": "warehouse"}}, format="json"
        )
        self.assertResponseNoErrors(response)
        self.shipment.refresh_from_db()
        self.assertDictEqual(self.shipment.metadata, {**self.link, "note": "warehouse"})

    def test_only_configured_integration_token_may_maintain_links(self):
        with self.settings(ERP_INTEGRATION_USER_ID=str(self.user.id)):
            response = self.client.put(
                self.url,
                {"metadata": {"karrio_shipment": "ERP-REPLACEMENT"}},
                format="json",
            )
        self.assertResponseNoErrors(response)
        self.shipment.refresh_from_db()
        self.assertEqual(self.shipment.metadata["karrio_shipment"], "ERP-REPLACEMENT")

    def test_create_rejects_forged_link_before_carrier_request(self):
        data = {**copy.deepcopy(SHIPMENT_DATA), "metadata": self.link}
        with patch("karrio.server.core.gateway.utils.identity") as provider:
            response = self.client.post(
                reverse("karrio.server.manager:shipment-list"), data, format="json"
            )
        self.assertEqual(response.status_code, 403)
        provider.assert_not_called()

    def test_generic_graphql_metadata_mutation_cannot_remove_link(self):
        from karrio.server.graph.schemas.base.mutations import MetadataMutation
        from karrio.server.graph import utils

        self.user.is_verified = lambda: True
        request = SimpleNamespace(
            user=self.user, token=self.token, org=None, test_mode=True
        )
        info = SimpleNamespace(context=SimpleNamespace(request=request))
        with self.assertRaises(APIException):
            MetadataMutation.mutate(
                info,
                id=self.shipment.pk,
                object_type=utils.MetadataObjectTypeEnum.shipment,
                discarded_keys=["karrio_shipment", "sales_order"],
            )
        self.shipment.refresh_from_db()
        self.assertDictEqual(self.shipment.metadata, self.link)

    def test_service_token_cannot_toggle_global_features(self):
        with patch("karrio.server.core.erp_gate.requests.post") as transport:
            response = self.client.post(
                reverse("karrio.server.manager:erp-features"),
                {"key": "gate_hold_block", "enabled": False},
                format="json",
            )
        self.assertEqual(response.status_code, 403)
        transport.assert_not_called()

    def test_ordinary_dashboard_user_cannot_toggle_global_features(self):
        self.user.is_staff = False
        self.user.is_superuser = False
        self.user.save()
        self.client.credentials()
        self.client.force_authenticate(user=self.user)
        with patch("karrio.server.core.erp_gate.requests.post") as transport:
            response = self.client.post(
                reverse("karrio.server.manager:erp-features"),
                {"key": "gate_hold_block", "enabled": False},
                format="json",
            )
        self.assertEqual(response.status_code, 403)
        transport.assert_not_called()

    def test_dashboard_manager_can_toggle_and_supplies_server_actor(self):
        token = self.getJWTToken(self.user.email, "test")
        self.client.credentials(HTTP_AUTHORIZATION="Bearer " + token)
        reply = Mock(status_code=200)
        reply.json.return_value = {
            "message": {"key": "gate_hold_block", "enabled": True}
        }
        with patch(
            "karrio.server.core.erp_gate.requests.post", return_value=reply
        ) as transport:
            with self.settings(
                ERP_GATE_URL="https://erp.invalid", ERP_GATE_TOKEN="test"
            ):
                response = self.client.post(
                    reverse("karrio.server.manager:erp-features"),
                    {"key": "gate_hold_block", "enabled": True, "actor": "forged"},
                    format="json",
                )
        self.assertResponseNoErrors(response)
        self.assertEqual(transport.call_args.kwargs["json"]["actor"], str(self.user.id))


@override_settings(MULTI_ORGANIZATIONS=True, ERP_ORGANIZATION_ID="org_erp")
class TestERPOrganizationAuthorization(SimpleTestCase):
    def context(self, org_id="org_erp", admin=False):
        memberships = Mock()
        memberships.filter.return_value.exists.return_value = admin
        return SimpleNamespace(
            user=SimpleNamespace(id="usr_manager", is_staff=True),
            token=None,
            org=SimpleNamespace(id=org_id, organization_users=memberships),
        )

    def test_other_organization_is_denied_even_for_staff(self):
        with self.assertRaises(APIException):
            assert_erp_feature_manager(self.context("org_other", admin=True))

    def test_matching_organization_requires_membership_admin(self):
        with self.assertRaises(APIException):
            assert_erp_feature_manager(self.context(admin=False))
        assert_erp_feature_manager(self.context(admin=True))

    @override_settings(ERP_ORGANIZATION_ID=None)
    def test_unconfigured_organization_fails_closed(self):
        with self.assertRaises(APIException):
            assert_erp_organization(self.context())

    @override_settings(ERP_INTEGRATION_USER_ID="usr_manager")
    def test_integration_identity_does_not_bypass_organization(self):
        ctx = self.context("org_other")
        ctx.token = SimpleNamespace(user_id="usr_manager")
        with self.assertRaises(APIException):
            assert_erp_metadata_write(ctx, {"sales_order": "SO-1"})

    def test_dashboard_label_purchase_cannot_relay_another_organization(self):
        shipment = SimpleNamespace(id="shp_other", metadata={"sales_order": "SO-1"})
        with patch("karrio.server.core.erp_gate.requests.post") as transport:
            with self.assertRaises(APIException) as caught:
                assert_erp_label_allowed(shipment, self.context("org_other"))
        self.assertEqual(caught.exception.status_code, 403)
        transport.assert_not_called()

    @override_settings(ERP_GATE_URL="https://erp.invalid", ERP_GATE_TOKEN="test")
    def test_matching_dashboard_org_can_reserve_label(self):
        shipment = SimpleNamespace(id="shp_erp", metadata={"sales_order": "SO-1"})

        def reserved(url, **kwargs):
            response = Mock()
            response.json.return_value = {
                "message": {
                    "allowed": True,
                    "reserved": True,
                    "operation_id": kwargs["json"]["operation_id"],
                }
            }
            return response

        with patch(
            "karrio.server.core.erp_gate.requests.post", side_effect=reserved
        ) as transport:
            assert_erp_label_allowed(shipment, self.context())
        self.assertFalse(transport.call_args.kwargs["json"]["allow_pending_binding"])
