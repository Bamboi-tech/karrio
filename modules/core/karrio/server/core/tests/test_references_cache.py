"""Tests for the cached, revalidatable /v1/references payload.

The dashboard keeps its last copy and revalidates it with ``If-None-Match``
on every page load, so the conditional path must stay cheap, must notice
every setting or connection change, and must never answer one scope with
another scope's payload.
"""

from unittest import mock

from constance import config
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework import status
from rest_framework.test import APITestCase, APIClient

import karrio.server.core.dataunits as dataunits
import karrio.server.providers.models as providers
from karrio.server.user.models import Token

URL = "/v1/references?reduced=true"
ORIGIN = "https://dashboard.example.com"


class TestReferencesCache(APITestCase):
    @classmethod
    def setUpTestData(cls) -> None:
        cls.user = get_user_model().objects.create_superuser(
            "owner@example.com", "test"
        )
        cls.token = Token.objects.create(user=cls.user, test_mode=False)
        cls.test_token = Token.objects.create(user=cls.user, test_mode=True)

    def setUp(self) -> None:
        cache.clear()
        self.client = APIClient()
        self.client.credentials(HTTP_AUTHORIZATION="Token " + self.token.key)

    def test_payload_is_built_once_and_served_as_stored(self):
        with mock.patch.object(
            dataunits, "contextual_reference", wraps=dataunits.contextual_reference
        ) as build:
            first = self.client.get(URL)
            second = self.client.get(URL)

        self.assertEqual(first.status_code, status.HTTP_200_OK)
        self.assertEqual(build.call_count, 1)
        self.assertEqual(first.content, second.content)
        self.assertEqual(first["ETag"], second["ETag"])
        self.assertEqual(first["Content-Type"], "application/json")
        self.assertEqual(first["Cache-Control"], "private, no-cache")
        self.assertIn("carriers", first.json())

    def test_revalidation_reads_the_validator_and_not_the_payload(self):
        first = self.client.get(URL)

        with mock.patch.object(cache, "get", wraps=cache.get) as cache_get:
            with self.assertNumQueries(0):
                revisit = self.client.get(URL, HTTP_IF_NONE_MATCH=first["ETag"])

        self.assertEqual(revisit.status_code, status.HTTP_304_NOT_MODIFIED)
        self.assertEqual(revisit.content, b"")
        self.assertEqual(revisit["ETag"], first["ETag"])
        self.assertEqual(revisit["Cache-Control"], "private, no-cache")
        reads = [
            str(call.args[0])
            for call in cache_get.call_args_list
            if str(call.args[0]).startswith("references:v2")
        ]
        self.assertEqual(len(reads), 1)
        self.assertTrue(reads[0].endswith(":etag"))

    def test_revalidation_survives_a_lost_validator_entry(self):
        first = self.client.get(URL)
        stored_get = cache.get

        def without_validator(key, *args, **kwargs):
            return (
                None if str(key).endswith(":etag") else stored_get(key, *args, **kwargs)
            )

        with mock.patch.object(cache, "get", side_effect=without_validator):
            revisit = self.client.get(URL, HTTP_IF_NONE_MATCH=first["ETag"])

        self.assertEqual(revisit.status_code, status.HTTP_304_NOT_MODIFIED)

    def test_setting_change_reaches_the_next_revalidation(self):
        first = self.client.get(URL)
        allow_signup = first.json()["ALLOW_SIGNUP"]

        config.ALLOW_SIGNUP = not allow_signup
        self.addCleanup(setattr, config, "ALLOW_SIGNUP", allow_signup)
        revisit = self.client.get(URL, HTTP_IF_NONE_MATCH=first["ETag"])

        self.assertEqual(revisit.status_code, status.HTTP_200_OK)
        self.assertEqual(revisit.json()["ALLOW_SIGNUP"], not allow_signup)
        self.assertNotEqual(revisit["ETag"], first["ETag"])

    def test_connection_change_rebuilds_before_the_next_revalidation(self):
        first = self.client.get(URL)
        carrier = providers.CarrierConnection.objects.create(
            carrier_code="generic",
            carrier_id="custom",
            test_mode=False,
            active=True,
            created_by=self.user,
            credentials=dict(custom_carrier_name="custom", display_name="Custom"),
        )

        with mock.patch.object(
            dataunits, "contextual_reference", wraps=dataunits.contextual_reference
        ) as build:
            added = self.client.get(URL, HTTP_IF_NONE_MATCH=first["ETag"])
            carrier.delete()
            removed = self.client.get(URL, HTTP_IF_NONE_MATCH=first["ETag"])

        # Rebuilt after each signal; an identical payload still revalidates.
        self.assertEqual(build.call_count, 2)
        self.assertIn(
            added.status_code, (status.HTTP_200_OK, status.HTTP_304_NOT_MODIFIED)
        )
        self.assertIn(
            removed.status_code, (status.HTTP_200_OK, status.HTTP_304_NOT_MODIFIED)
        )

    def test_payload_does_not_depend_on_the_caller(self):
        """The view runs without authenticators (upstream), so DRF resets the
        request user before the payload is built: every caller gets the same,
        caller-free payload. The browser may therefore keep a copy; if this
        ever changes, the stored copy becomes user data and must be scoped."""
        providers.CarrierConnection.objects.create(
            carrier_code="generic",
            carrier_id="custom",
            test_mode=False,
            active=True,
            created_by=self.user,
            credentials=dict(custom_carrier_name="owner_carrier", display_name="Owner"),
        )

        signed_in = self.client.get(URL)
        anonymous = APIClient().get(URL)

        self.assertEqual(signed_in["ETag"], anonymous["ETag"])
        self.assertEqual(signed_in.json()["custom_carriers"], {})
        self.assertNotIn("owner_carrier", signed_in.content.decode())

    def test_scopes_do_not_share_a_validator(self):
        def scoped_payload(request=None, reduced=True):
            from karrio.server.core.middleware import SessionContext

            current = SessionContext.get_current_request()
            return {"test_mode": current.test_mode, "reduced": reduced}

        with mock.patch.object(dataunits, "contextual_reference", scoped_payload):
            live = self.client.get(URL)
            test_client = APIClient()
            test_client.credentials(HTTP_AUTHORIZATION="Token " + self.test_token.key)
            test_mode = test_client.get(URL, HTTP_IF_NONE_MATCH=live["ETag"])
            full = self.client.get(
                "/v1/references?reduced=false", HTTP_IF_NONE_MATCH=live["ETag"]
            )
            live_again = self.client.get(URL, HTTP_IF_NONE_MATCH=live["ETag"])

        self.assertEqual(live.json(), {"test_mode": False, "reduced": True})
        self.assertEqual(test_mode.status_code, status.HTTP_200_OK)
        self.assertEqual(test_mode.json(), {"test_mode": True, "reduced": True})
        self.assertEqual(full.status_code, status.HTTP_200_OK)
        self.assertEqual(full.json(), {"test_mode": False, "reduced": False})
        self.assertEqual(live_again.status_code, status.HTTP_304_NOT_MODIFIED)

    def test_cross_origin_dashboard_can_send_and_read_the_validator(self):
        preflight = self.client.options(
            URL,
            HTTP_ORIGIN=ORIGIN,
            HTTP_ACCESS_CONTROL_REQUEST_METHOD="GET",
            HTTP_ACCESS_CONTROL_REQUEST_HEADERS="authorization,if-none-match",
        )
        self.assertIn("if-none-match", preflight["Access-Control-Allow-Headers"])

        response = self.client.get(URL, HTTP_ORIGIN=ORIGIN)
        self.assertIn("etag", response["Access-Control-Expose-Headers"].lower())
