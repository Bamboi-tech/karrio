"""The warm response cache for the shipments board (PRDs/SHIPMENTS_WARM_LIST_CACHE.md)."""

import os
import json
import unittest
from unittest import mock
from django.db import connection
from django.core.cache import cache
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from django.contrib.auth import get_user_model
from huey.contrib.djhuey import HUEY as huey_instance

import karrio.server.core.warm_cache as core
import karrio.server.graph.tasks as tasks
import karrio.server.graph.schema as schema
import karrio.server.graph.warm_cache as warm_cache
import karrio.server.manager.models as manager
import karrio.server.manager.serializers.tracking as tracking
from karrio.server.graph.tests.base import GraphTestCase
from karrio.server.graph.tests.test_shipments_list_cost import (
    ShipmentsListFixtures,
    GET_SHIPMENTS_LIST,
    GET_SHIPMENT_BADGE_COUNTS,
    DASHBOARD_STATUSES,
)

WARM = dict(SHIPMENTS_WARM_USERS=["admin@example.com", "packer@example.com"])


def _never_execute(*args, **kwargs):
    raise AssertionError("a warm hit must not reach Strawberry")


@override_settings(**WARM)
class TestShipmentsWarmCache(ShipmentsListFixtures, GraphTestCase):
    def setUp(self) -> None:
        super().setUp()
        cache.clear()
        # The warmer is a huey task; in tests it runs inline, as in a
        # deployment without a worker (DETACHED_WORKER without Redis).
        self._immediate = huey_instance.immediate
        huey_instance.immediate = True
        self.login(self.user.email)

    def tearDown(self) -> None:
        huey_instance.immediate = self._immediate
        super().tearDown()

    def login(self, email: str, **headers):
        self.client.credentials(
            HTTP_AUTHORIZATION="Bearer " + self.getJWTToken(email, "test"), **headers
        )
        # Fill the per-process auth caches so a list request counts its own SQL.
        self.post("query Ping { __typename }", "Ping")

    def badges(self):
        return self.post(GET_SHIPMENT_BADGE_COUNTS, "shipment_badge_counts")

    def queries(self, request) -> list:
        with CaptureQueriesContext(connection) as context:
            response = request()
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("errors", json.loads(response.content))
        return context.captured_queries

    def change(self, shipment_id: str, **fields):
        """Change a row the way the API does: inside a transaction whose
        commit callbacks run, so the data version moves and the warmer runs."""
        with self.captureOnCommitCallbacks(execute=True):
            manager.Shipment.all_objects.filter(id=shipment_id).update(**fields)
            manager.Shipment.all_objects.get(id=shipment_id).save()

    def test_miss_then_hit(self):
        miss = self.shipments()
        with mock.patch.object(schema.schema, "execute_sync", _never_execute):
            hit_queries = self.queries(self.shipments)
            hit = self.shipments()
        self.assertEqual(hit_queries, [])
        self.assertEqual(hit.content, miss.content)
        self.assertEqual(hit["Content-Type"], "application/json")
        self.assertEqual(hit.cookies.keys(), miss.cookies.keys())
        self.assertEqual(hit["X-test-mode"], miss["X-test-mode"])

        miss = self.badges()
        with mock.patch.object(schema.schema, "execute_sync", _never_execute):
            self.assertEqual(self.queries(self.badges), [])
            self.assertEqual(self.badges().content, miss.content)

    def test_a_change_invalidates_and_the_warmer_refreshes(self):
        self.shipments()
        self.badges()
        before = json.loads(self.shipments().content)
        newest = before["data"]["shipments"]["edges"][0]["node"]
        self.assertEqual(newest["reference"], "SO-2026-10039")

        self.change(newest["id"], reference="SO-2026-99999")

        # The warmer ran inline on commit: the next requests hit and are fresh.
        with mock.patch.object(schema.schema, "execute_sync", _never_execute):
            self.assertEqual(self.queries(self.shipments), [])
            self.assertEqual(self.queries(self.badges), [])
            after = json.loads(self.shipments().content)
        self.assertEqual(
            after["data"]["shipments"]["edges"][0]["node"]["reference"], "SO-2026-99999"
        )

    def test_a_stale_body_is_never_served_without_the_warmer(self):
        self.shipments()
        newest = self.fixtures[-1]["id"]
        with mock.patch.object(warm_cache, "warm", return_value=0):
            self.change(newest, reference="SO-2026-77777")
        # A version mismatch is a miss: the request executes and sees the row.
        queries = self.queries(self.shipments)
        self.assertEqual(len(queries), 2, [q["sql"][:120] for q in queries])
        node = json.loads(self.shipments().content)["data"]["shipments"]["edges"][0]
        self.assertEqual(node["node"]["reference"], "SO-2026-77777")

    def test_bulk_tracker_save_moves_the_version(self):
        version = core.data_version()
        tracker = manager.Tracking.all_objects.select_related("shipment").first()
        tracker.status = "delivered"
        with self.captureOnCommitCallbacks(execute=True):
            tracking.bulk_save_trackers([(tracker, ["status"])])
        self.assertGreater(core.data_version(), version)

    def test_warmer_re_executes_what_a_user_used(self):
        self.shipments(first=20)
        self.shipments(first=5)
        self.badges()
        (scope,) = warm_cache.scopes()
        for item in cache.get(warm_cache.recent_key(scope)):
            # an eviction or a worker restart
            cache.delete(warm_cache.body_key(scope, warm_cache.Operation(**item)))
        self.assertEqual(tasks.warm_shipments_lists_periodic.call_local(), 3)
        with mock.patch.object(schema.schema, "execute_sync", _never_execute):
            for request in (
                lambda: self.shipments(20),
                lambda: self.shipments(5),
                self.badges,
            ):
                self.assertEqual(self.queries(request), [])
        # Nothing stale: a second run has nothing to do.
        self.assertEqual(tasks.warm_shipments_lists_periodic.call_local(), 0)

    def test_warmed_body_is_byte_identical_to_a_normal_response(self):
        with override_settings(SHIPMENTS_WARM_USERS=[]):
            normal = self.shipments().content
        self.shipments()
        (scope,) = warm_cache.scopes()
        operation = warm_cache.Operation(**cache.get(warm_cache.recent_key(scope))[0])
        cache.delete(warm_cache.body_key(scope, operation))
        self.assertEqual(warm_cache.warm(), 1)
        self.assertEqual(
            cache.get(warm_cache.body_key(scope, operation)), (core.data_version(), normal)
        )
        with mock.patch.object(schema.schema, "execute_sync", _never_execute):
            self.assertEqual(self.shipments().content, normal)

    def test_recent_sets_are_capped_and_most_recent_first(self):
        for first in range(1, 11):
            self.shipments(first=first)
        (scope,) = warm_cache.scopes()
        recent = cache.get(warm_cache.recent_key(scope))
        self.assertEqual(
            [item["variables"]["filter"]["first"] for item in recent],
            [10, 9, 8, 7, 6, 5, 4, 3],
        )

    def test_users_are_isolated(self):
        packer = get_user_model().objects.create_superuser("packer@example.com", "test")
        self.shipments()
        self.login(packer.email)
        # Another designated user: a miss of their own, then their own hit.
        self.assertEqual(len(self.queries(self.shipments)), 2)
        self.assertEqual(self.queries(self.shipments), [])
        self.assertEqual(len(warm_cache.scopes()), 2)

    def test_test_mode_is_isolated(self):
        live = self.shipments()
        self.login(self.user.email, HTTP_X_TEST_MODE="true")
        test = self.shipments()
        self.assertEqual(json.loads(test.content)["data"]["shipments"]["edges"], [])
        self.assertNotEqual(test.content, live.content)
        with mock.patch.object(schema.schema, "execute_sync", _never_execute):
            self.assertEqual(self.shipments().content, test.content)

    def test_non_designated_user_is_untouched(self):
        other = get_user_model().objects.create_superuser("other@example.com", "test")
        self.login(other.email)
        self.assertEqual(len(self.queries(self.shipments)), 2)
        self.assertEqual(len(self.queries(self.shipments)), 2)
        self.assertIsNone(cache.get(warm_cache.SCOPES_KEY))

    @override_settings(SHIPMENTS_WARM_USERS=[])
    def test_feature_off_when_the_setting_is_empty(self):
        self.assertEqual(len(self.queries(self.shipments)), 2)
        self.assertEqual(len(self.queries(self.shipments)), 2)
        self.assertIsNone(cache.get(warm_cache.SCOPES_KEY))
        self.change(self.fixtures[0]["id"], reference="x")
        self.assertIsNone(cache.get(core.VERSION_KEY))

    def test_only_the_allowed_queries_are_cached(self):
        parse = warm_cache.parse_operation
        variables = {"filter": {"first": 1}}
        self.assertIsNotNone(parse(dict(query=GET_SHIPMENTS_LIST, variables=variables)))
        self.assertIsNotNone(
            parse(dict(query=GET_SHIPMENTS_LIST, operationName="get_shipments_list"))
        )
        self.assertIsNone(parse(dict(query=GET_SHIPMENTS_LIST, operationName="other")))
        self.assertIsNone(
            parse(dict(query="mutation get_shipments_list { __typename }"))
        )
        self.assertIsNone(parse(dict(query="query GetUser { user { email } }")))
        self.assertIsNone(parse(dict(query="{ __typename }")))
        self.assertIsNone(parse(dict(query=GET_SHIPMENTS_LIST, variables=[1])))
        self.assertIsNone(parse([]))

    def test_errors_are_not_cached(self):
        broken = lambda: self.post(
            GET_SHIPMENTS_LIST, "get_shipments_list", {"filter": {"first": "x"}}
        )
        self.assertIn("errors", json.loads(broken().content))
        self.assertIsNone(cache.get(warm_cache.SCOPES_KEY))

    def test_a_cache_failure_degrades_to_normal_execution(self):
        expected = self.shipments().content
        with mock.patch.object(cache, "get_many", side_effect=OSError("redis down")):
            response = self.shipments()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, expected)

    def test_a_warm_run_never_executes_a_mutation(self):
        self.shipments()
        request = warm_cache.request_for(warm_cache.scopes()[0])
        self.assertIsNone(
            warm_cache.render(
                request,
                warm_cache.Operation(
                    "get_shipments_list",
                    "mutation get_shipments_list { __typename }",
                    None,
                ),
            )
        )

    @unittest.skipUnless(os.environ.get("SHIPMENTS_LIST_PROFILE"), "opt-in measurement")
    def test_profile(self):
        """SHIPMENTS_LIST_PROFILE=1 karrio test ...test_shipments_warm_cache: miss vs hit."""
        import time

        for name, request in (
            ("list first=20", lambda: self.shipments(first=20)),
            ("badge counts", self.badges),
        ):
            for kind in ("miss", "hit"):
                wall = []
                for _ in range(60):
                    if kind == "miss":
                        cache.clear()
                    started = time.perf_counter()
                    body = request().content
                    wall.append(time.perf_counter() - started)
                print(
                    f"\n{name} {kind}: {len(body)} bytes, wall {min(wall) * 1000:.2f} ms "
                    f"(median {sorted(wall)[30] * 1000:.2f})"
                )
        # The hit path's own Python: body parse, key, one cache read.
        from django.test import RequestFactory

        variables = {"filter": {"offset": 0, "first": 20, "status": DASHBOARD_STATUSES}}
        request = RequestFactory().post(
            "/graphql", dict(query=GET_SHIPMENTS_LIST, variables=variables), "application/json"
        )
        request.user, request.test_mode, request.org = self.user, False, None
        self.shipments()
        timings = []
        for _ in range(200):
            started = time.perf_counter()
            body = warm_cache.lookup(*warm_cache.request_entry(request))[1]
            timings.append(time.perf_counter() - started)
        assert body
        print(f"\nhit path (entry + lookup): median {sorted(timings)[100] * 1e6:.0f} us")
