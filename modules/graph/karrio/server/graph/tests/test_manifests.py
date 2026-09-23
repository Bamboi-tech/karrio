import json
from unittest.mock import ANY, patch
from django.urls import reverse
from rest_framework import status
from karrio.server.graph.tests.base import GraphTestCase
from karrio.server.manager.tests.test_manifests import MANIFEST_RESPONSE
from karrio.server.manager.tests.test_shipments import (
    RETURNED_RATES_VALUE,
    CREATED_SHIPMENT_RESPONSE,
    SINGLE_CALL_LABEL_DATA,
)


class TestManifestQueries(GraphTestCase):
    @classmethod
    def setUpTestData(cls) -> None:
        super().setUpTestData()
        cls.carrier.capabilities = [*cls.carrier.capabilities, "manifest"]
        cls.carrier.save()

    def setUp(self) -> None:
        super().setUp()
        self.manifest = self._create_manifest()

    def _create_manifest(self):
        """Create a purchased shipment and a manifest for it using the REST API"""
        with patch("karrio.server.core.gateway.utils.identity") as mock:
            mock.side_effect = [RETURNED_RATES_VALUE, CREATED_SHIPMENT_RESPONSE]
            response = self.client.post(
                reverse("karrio.server.manager:shipment-list"), SINGLE_CALL_LABEL_DATA
            )
            self.assertEqual(response.status_code, status.HTTP_201_CREATED)
            shipment = json.loads(response.content)

        with patch("karrio.server.core.gateway.utils.identity") as mock:
            mock.return_value = MANIFEST_RESPONSE
            response = self.client.post(
                reverse("karrio.server.manager:manifest-list"),
                dict(**MANIFEST_DATA, shipment_ids=[shipment["id"]]),
            )
            self.assertEqual(response.status_code, status.HTTP_201_CREATED)
            return json.loads(response.content)

    def test_query_manifests_address(self):
        response = self.query(
            """
            query get_manifests {
              manifests {
                edges {
                  node {
                    id
                    address {
                      id
                      object_type
                      address_line1
                      city
                      postal_code
                      country_code
                      state_code
                    }
                  }
                }
              }
            }
            """,
            operation_name="get_manifests",
        )

        self.assertResponseNoErrors(response)
        self.assertDictEqual(response.data, MANIFESTS_RESPONSE)

        node = response.data["data"]["manifests"]["edges"][0]["node"]
        self.assertEqual(node["id"], self.manifest["id"])
        self.assertEqual(node["address"]["id"], self.manifest["address"]["id"])


MANIFEST_DATA = {
    "carrier_name": "canadapost",
    "address": {
        "address_line1": "125 Church St",
        "city": "Moncton",
        "country_code": "CA",
        "postal_code": "E1C4Z8",
        "state_code": "NB",
    },
}

MANIFESTS_RESPONSE = {
    "data": {
        "manifests": {
            "edges": [
                {
                    "node": {
                        "id": ANY,
                        "address": {
                            "id": ANY,
                            "object_type": "address",
                            "address_line1": "125 Church St",
                            "city": "Moncton",
                            "postal_code": "E1C4Z8",
                            "country_code": "CA",
                            "state_code": "NB",
                        },
                    }
                }
            ]
        }
    }
}
