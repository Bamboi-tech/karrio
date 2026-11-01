import types as pytypes
from unittest import mock

from django.core.cache import cache

from karrio.server.graph.tests import GraphTestCase
import karrio.server.graph.schemas.base.types as types

ALIGNED_FILTER = {
    "date_after": "2026-10-16T10:00:00.000Z",
    "date_before": "2026-10-31T10:05:00.000Z",
}
UNALIGNED_FILTER = {
    "date_after": "2026-10-16T10:02:30.000Z",
    "date_before": "2026-10-31T10:04:59.000Z",
}


class TestSystemUsage(GraphTestCase):
    def setUp(self) -> None:
        super().setUp()
        cache.clear()

    def test_bounds_are_parsed_exactly(self):
        date_after, date_before = types._usage_bounds(UNALIGNED_FILTER)

        self.assertEqual(date_after.isoformat(), "2026-10-16T10:02:30+00:00")
        self.assertEqual(date_before.isoformat(), "2026-10-31T10:04:59+00:00")

    def test_date_only_bound_is_midnight_utc(self):
        date_after, _ = types._usage_bounds(
            {"date_after": "2026-10-16", "date_before": "2026-10-31T10:05:00Z"}
        )

        self.assertEqual(date_after.isoformat(), "2026-10-16T00:00:00+00:00")

    def test_only_five_minute_windows_are_cacheable(self):
        self.assertTrue(
            types._is_cacheable_window(*types._usage_bounds(ALIGNED_FILTER))
        )
        self.assertFalse(
            types._is_cacheable_window(*types._usage_bounds(UNALIGNED_FILTER))
        )

    def test_cache_key_separates_org_and_mode(self):
        date_after, date_before = types._usage_bounds(ALIGNED_FILTER)
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

    def test_aligned_window_is_served_from_cache(self):
        first = self.query(
            USAGE_QUERY,
            operation_name="GetSystemUsage",
            variables={"filter": ALIGNED_FILTER},
        )
        self.assertResponseNoErrors(first)

        with mock.patch.object(
            types, "_compute_system_usage", wraps=types._compute_system_usage
        ) as compute:
            second = self.query(
                USAGE_QUERY,
                operation_name="GetSystemUsage",
                variables={"filter": ALIGNED_FILTER},
            )

        self.assertResponseNoErrors(second)
        compute.assert_not_called()
        self.assertDictEqual(first.data, second.data)

    def test_another_window_recomputes(self):
        first = self.query(
            USAGE_QUERY,
            operation_name="GetSystemUsage",
            variables={"filter": ALIGNED_FILTER},
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
                        "date_before": "2026-10-31T10:05:00.000Z",
                    }
                },
            )

        self.assertResponseNoErrors(second)
        compute.assert_called_once()

    def test_unaligned_window_is_computed_every_time_with_exact_bounds(self):
        with mock.patch.object(
            types, "_compute_system_usage", wraps=types._compute_system_usage
        ) as compute:
            for _ in range(2):
                result = self.query(
                    USAGE_QUERY,
                    operation_name="GetSystemUsage",
                    variables={"filter": UNALIGNED_FILTER},
                )
                self.assertResponseNoErrors(result)

        self.assertEqual(compute.call_count, 2)
        bounds = compute.call_args.args[0]
        self.assertEqual(bounds["date_after"].isoformat(), "2026-10-16T10:02:30+00:00")
        self.assertEqual(bounds["date_before"].isoformat(), "2026-10-31T10:04:59+00:00")


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
