import types as pytypes
from unittest import mock

from django.core.cache import cache

from karrio.server.graph.tests import GraphTestCase
import karrio.server.graph.schemas.base.types as types


class TestSystemUsage(GraphTestCase):
    def setUp(self) -> None:
        super().setUp()
        cache.clear()

    def test_usage_window_rounds_outwards_to_five_minutes(self):
        date_after, date_before = types._usage_window(
            {
                "date_after": "2026-10-16T10:02:30.123Z",
                "date_before": "2026-10-31T10:04:59.000Z",
            }
        )

        self.assertEqual(date_after.isoformat(), "2026-10-16T10:00:00+00:00")
        self.assertEqual(date_before.isoformat(), "2026-10-31T10:05:00+00:00")

    def test_usage_window_keeps_aligned_bounds(self):
        date_after, date_before = types._usage_window(
            {"date_after": "2026-10-16", "date_before": "2026-10-31T10:05:00Z"}
        )

        self.assertEqual(date_after.isoformat(), "2026-10-16T00:00:00+00:00")
        self.assertEqual(date_before.isoformat(), "2026-10-31T10:05:00+00:00")

    def test_cache_key_separates_org_and_mode(self):
        date_after, date_before = types._usage_window(
            {
                "date_after": "2026-10-16T10:00:00Z",
                "date_before": "2026-10-31T10:00:00Z",
            }
        )
        live = pytypes.SimpleNamespace(org=None, test_mode=False)
        test = pytypes.SimpleNamespace(org=None, test_mode=True)
        org = pytypes.SimpleNamespace(
            org=pytypes.SimpleNamespace(pk="org_1"), test_mode=False
        )

        keys = {
            types._system_usage_cache_key(request, date_after, date_before)
            for request in (live, test, org)
        }

        self.assertEqual(len(keys), 3)

    def test_system_usage_is_served_from_cache_within_the_window(self):
        first = self.query(
            USAGE_QUERY,
            operation_name="GetSystemUsage",
            variables={
                "filter": {
                    "date_after": "2026-10-16T10:00:00.000Z",
                    "date_before": "2026-10-31T10:00:01.000Z",
                }
            },
        )
        self.assertResponseNoErrors(first)

        with mock.patch.object(
            types, "_compute_system_usage", wraps=types._compute_system_usage
        ) as compute:
            second = self.query(
                USAGE_QUERY,
                operation_name="GetSystemUsage",
                variables={
                    "filter": {
                        "date_after": "2026-10-16T10:02:30.000Z",
                        "date_before": "2026-10-31T10:04:59.000Z",
                    }
                },
            )

        self.assertResponseNoErrors(second)
        compute.assert_not_called()
        self.assertDictEqual(first.data, second.data)

    def test_system_usage_recomputes_for_another_window(self):
        first = self.query(
            USAGE_QUERY,
            operation_name="GetSystemUsage",
            variables={
                "filter": {
                    "date_after": "2026-10-16T10:00:00.000Z",
                    "date_before": "2026-10-31T10:00:00.000Z",
                }
            },
        )
        self.assertResponseNoErrors(first)

        with mock.patch.object(
            types, "_compute_system_usage", wraps=types._compute_system_usage
        ) as compute:
            second = self.query(
                USAGE_QUERY,
                operation_name="GetSystemUsage",
                variables={
                    "filter": {
                        "date_after": "2026-10-24T10:00:00.000Z",
                        "date_before": "2026-10-31T10:00:00.000Z",
                    }
                },
            )

        self.assertResponseNoErrors(second)
        compute.assert_called_once()


USAGE_QUERY = """
query GetSystemUsage($filter: UsageFilter) {
  system_usage(filter: $filter) {
    total_errors
    total_requests
    total_trackers
    total_shipments
    total_shipping_spend
    order_volume
    shipment_count {
      label
      count
      date
    }
    api_requests {
      label
      count
      date
    }
  }
}
"""
