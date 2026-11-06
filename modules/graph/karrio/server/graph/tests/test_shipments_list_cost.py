"""What the dashboard's /shipments page costs the API.

The page fires GET_SHIPMENTS_LIST with its default filter (first: 20) next to
GET_SHIPMENT_BADGE_COUNTS. These tests pin the response for realistic rows,
the number of SQL statements per request and the columns the list reads, so a
regression shows up as a failing test instead of a slow page.
"""

import os
import re
import json
import base64
import random
import pathlib
import datetime
import unittest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from karrio.server.graph.tests.base import GraphTestCase
import karrio.server.manager.models as manager

# Copies of the dashboard queries (packages/types/graphql/queries.ts);
# test_query_text_matches_the_dashboard fails when they drift apart.
GET_SHIPMENTS_LIST = """
  query get_shipments_list($filter: ShipmentFilter) {
    shipments(filter: $filter) {
      page_info {
        count
        has_next_page
        has_previous_page
        start_cursor
        end_cursor
      }
      edges {
        node {
          id
          carrier_id
          carrier_name
          created_at
          updated_at
          status
          recipient {
            id
            postal_code
            city
            person_name
            company_name
            country_code
            state_code
            address_line1
            address_line2
          }
          parcels {
            id
            items {
              id
              title
              description
              quantity
              sku
            }
          }
          label_type
          tracking_number
          label_url
          invoice_url
          tracker_id
          service
          reference
          selected_rate {
            id
            carrier_name
            carrier_id
            currency
            service
            transit_days
            total_charge
            meta
          }
          rates {
            id
            carrier_name
            carrier_id
            service
            meta
          }
          options
          metadata
          meta
          selected_rate_carrier {
            connection_id
            connection_type
            carrier_code
            carrier_id
            carrier_name
            test_mode
          }
        }
      }
    }
  }
"""
GET_SHIPMENT_BADGE_COUNTS = """
  query shipment_badge_counts {
    today: shipments(filter: {warehouse_view: "today", first: 1}) { page_info { count } }
    hold: shipments(filter: {status: [draft], metadata_key: "shopify_hold", first: 1}) { page_info { count } }
    review: shipments(filter: {status: [draft], metadata_key: "address_review_required", first: 1}) { page_info { count } }
  }
"""
GET_USER = """
  query GetUser {
    user {
      email
      full_name
      is_staff
      is_superuser
      last_login
      date_joined
      permissions
    }
  }
"""
DASHBOARD_STATUSES = [
    "draft",
    "created",
    "shipped",
    "delivered",
    "in_transit",
    "cancelled",
    "needs_attention",
    "out_for_delivery",
    "delivery_failed",
]
STATUSES = [
    "draft",
    "draft",
    "created",
    "shipped",
    "in_transit",
    "delivered",
    "needs_attention",
    "cancelled",
]
TRACKED = ("shipped", "in_transit", "delivered", "needs_attention")
EPOCH = datetime.datetime(2026, 11, 2, 8, 0, tzinfo=datetime.timezone.utc)
# A label is a base64 document of tens of kilobytes (compressed, so it does not
# shrink in storage); the list never shows it.
LABEL = base64.b64encode(random.Random(0).randbytes(30000)).decode()
ROWS = 40


def _rate(i: int, n: int) -> dict:
    return {
        "id": f"rat_{i:028x}{n:04x}",
        "object_type": "rate",
        "carrier_name": ("dhl_parcel_de", "ups", "generic")[n],
        "carrier_id": ("dhl-nl", "ups-eu", "monta")[n],
        "service": ("dhl_parcel_de_paket", "ups_standard", "monta_own_delivery")[n],
        "test_mode": False,
        "currency": "EUR",
        "total_charge": 6.75 + n + i / 100,
        "transit_days": n + 1,
        "extra_charges": [
            {"name": "Base charge", "amount": 5.5 + n, "currency": "EUR"},
            {"name": "Fuel surcharge", "amount": 1.25 + i / 100, "currency": "EUR"},
        ],
        "meta": {
            "service_name": ("DHL Paket", "UPS Standard", "Own delivery")[n],
            "carrier_connection_id": f"car_{n:032x}",
            "rate_provider": ("dhl_parcel_de", "ups", "monta")[n],
            "ext": ("dhl_parcel_de", "ups", "generic")[n],
        },
    }


def _fixture(i: int) -> dict:
    status = STATUSES[i % len(STATUSES)]
    bought = status != "draft"
    rates = [_rate(i, n) for n in range(3)]
    return dict(
        id=f"shp_{i:032x}",
        status=status,
        test_mode=False,
        reference=f"SO-2026-{10000 + i}",
        order_id=f"ord_{i:05d}",
        label_type="PDF" if bought else None,
        tracking_number=f"JVGL0{60000000 + i}" if bought else None,
        label=LABEL if bought else None,
        invoice=LABEL[:20000] if (bought and i % 5 == 0) else None,
        recipient={
            "id": f"adr_{i:032x}",
            "person_name": f"Recipient {i}",
            "company_name": None if i % 3 else f"Company {i}",
            "address_line1": f"Veemarkt {i}",
            "address_line2": None if i % 4 else "2e etage",
            "postal_code": f"{1000 + i}AB",
            "city": "Amsterdam",
            "state_code": None,
            "country_code": "NL",
            "email": f"recipient{i}@example.com",
            "phone_number": "+31600000000",
            "residential": True,
        },
        shipper={
            "id": f"adr_{i + 1000:032x}",
            "company_name": "Warehouse",
            "address_line1": "Dok 1",
            "postal_code": "3542AD",
            "city": "Utrecht",
            "country_code": "NL",
        },
        parcels=[
            {
                "id": f"pcl_{i:028x}{p:04x}",
                "weight": 12.5 + p,
                "weight_unit": "KG",
                "width": 40,
                "height": 30,
                "length": 60,
                "dimension_unit": "CM",
                "packaging_type": "your_packaging",
                "reference_number": f"SO-2026-{10000 + i}-{p}",
                "items": [
                    {
                        "id": f"cdt_{i:024x}{p:04x}{c:04x}",
                        "title": f"Plank {c}",
                        "description": None if c else "Bamboo decking 1850x140x20",
                        "quantity": c + 2,
                        "sku": f"BB-{i:04d}-{c}",
                        "weight": 4.2,
                        "weight_unit": "KG",
                        "value_amount": 59.95,
                        "value_currency": "EUR",
                        "origin_country": "CN",
                        "metadata": {"sales_order_item": f"soi_{i}_{p}_{c}"},
                    }
                    for c in range(2)
                ],
            }
            for p in range(1 + i % 3)
        ],
        rates=rates,
        selected_rate=rates[i % 3] if bought else None,
        carrier=(
            {
                "connection_id": f"car_{i % 3:032x}",
                "connection_type": "account",
                "carrier_code": rates[i % 3]["carrier_name"],
                "carrier_id": rates[i % 3]["carrier_id"],
                "carrier_name": rates[i % 3]["carrier_name"],
                "test_mode": False,
            }
            if bought
            else None
        ),
        payment={"paid_by": "sender", "currency": "EUR"},
        options={
            "currency": "EUR",
            "shipment_date": "2026-11-06",
            "declared_value": 120.5 + i,
        },
        metadata={
            "sales_order": f"SO-2026-{10000 + i}",
            "erp_status": "Label Created" if bought else "Synced",
            "print_date": f"2020-11-{1 + i % 28:02d}",
            "source_warehouse": "Utrecht - B",
            "fulfilment_mode": "carrier" if i % 4 else "self_delivery",
            **({"shopify_hold": "1"} if i % 16 == 1 else {}),
            **({"address_review_required": True} if i % 16 == 9 else {}),
        },
        meta={
            "request_id": f"req_{i:032x}",
            "service_name": "DHL Paket",
            **(
                {"carrier_tracking_link": f"https://track.example.com/{i}"}
                if bought
                else {}
            ),
        },
    )


def _expected_node(data: dict) -> dict:
    """What GET_SHIPMENTS_LIST selects, written out from the fixture."""
    rate = data["selected_rate"]
    stamp = (EPOCH + datetime.timedelta(minutes=int(data["id"][4:], 16))).isoformat()
    docs = f"/v1/shipments/{data['id']}/"
    return {
        "id": data["id"],
        "carrier_id": rate and rate["carrier_id"],
        "carrier_name": rate and rate["carrier_name"],
        "created_at": stamp,
        "updated_at": stamp,
        "status": data["status"],
        "recipient": {
            key: data["recipient"][key]
            for key in (
                "id",
                "postal_code",
                "city",
                "person_name",
                "company_name",
                "country_code",
                "state_code",
                "address_line1",
                "address_line2",
            )
        },
        "parcels": [
            {
                "id": parcel["id"],
                "items": [
                    {
                        key: item[key]
                        for key in ("id", "title", "description", "quantity", "sku")
                    }
                    for item in parcel["items"]
                ],
            }
            for parcel in data["parcels"]
        ],
        "label_type": data["label_type"],
        "tracking_number": data["tracking_number"],
        "label_url": data["label"] and docs + "label.pdf",
        "invoice_url": data["invoice"] and docs + "invoice.pdf",
        "tracker_id": f"trk_{data['id'][4:]}" if data["status"] in TRACKED else None,
        "service": rate and rate["service"],
        "reference": data["reference"],
        "selected_rate": rate
        and {
            key: rate[key]
            for key in (
                "id",
                "carrier_name",
                "carrier_id",
                "currency",
                "service",
                "transit_days",
                "total_charge",
                "meta",
            )
        },
        "rates": [
            {
                key: r[key]
                for key in ("id", "carrier_name", "carrier_id", "service", "meta")
            }
            for r in data["rates"]
        ],
        "options": data["options"],
        "metadata": data["metadata"],
        "meta": data["meta"],
        "selected_rate_carrier": data["carrier"],
    }


def _statements(queries, table: str) -> list:
    return [q["sql"] for q in queries if f'FROM "{table}"' in q["sql"]]


class TestShipmentsListCost(GraphTestCase):
    @classmethod
    def setUpTestData(cls) -> None:
        super().setUpTestData()
        cls.fixtures = [_fixture(i) for i in range(ROWS)]
        manager.Shipment.all_objects.bulk_create(
            [manager.Shipment(created_by=cls.user, **data) for data in cls.fixtures]
        )
        manager.Tracking.all_objects.bulk_create(
            [
                manager.Tracking(
                    id=f"trk_{data['id'][4:]}",
                    created_by=cls.user,
                    shipment_id=data["id"],
                    tracking_number=data["tracking_number"],
                    status="in_transit",
                    test_mode=False,
                    carrier=data["carrier"],
                    delivery_image=LABEL[:30000],
                    signature_image=LABEL[:15000],
                    events=[
                        {
                            "date": "2026-11-05",
                            "time": f"{hour:02d}:15",
                            "code": "PU",
                            "description": "Shipment picked up",
                            "location": "Utrecht, NL",
                        }
                        for hour in range(8, 20)
                    ],
                )
                for data in cls.fixtures
                if data["status"] in TRACKED
            ]
        )
        # auto_now(_add) stamps every row with "now"; give each its own minute
        # so the default "-created_at" order and the timestamps are fixed.
        for i, data in enumerate(cls.fixtures):
            stamp = EPOCH + datetime.timedelta(minutes=i)
            manager.Shipment.all_objects.filter(id=data["id"]).update(
                created_at=stamp, updated_at=stamp
            )

    def setUp(self) -> None:
        super().setUp()
        # The dashboard authenticates with a JWT, not an API token.
        self.client.credentials(
            HTTP_AUTHORIZATION="Bearer " + self.getJWTToken(self.user.email, "test")
        )

    def post(self, query: str, operation_name: str, variables: dict = None):
        return self.client.post(
            "/graphql",
            dict(query=query, operation_name=operation_name, variables=variables),
            format="json",
        )

    def shipments(self, first: int = 20):
        return self.post(
            GET_SHIPMENTS_LIST,
            "get_shipments_list",
            {"filter": {"offset": 0, "first": first, "status": DASHBOARD_STATUSES}},
        )

    def capture(self, request) -> list:
        request()  # warm the per-process caches (auth, content types)
        with CaptureQueriesContext(connection) as context:
            response = request()
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("errors", json.loads(response.content))
        return context.captured_queries

    def test_query_text_matches_the_dashboard(self):
        source = next(
            (
                parent / "packages/types/graphql/queries.ts"
                for parent in pathlib.Path(__file__).resolve().parents
                if (parent / "packages/types/graphql/queries.ts").exists()
            ),
            None,
        )
        if source is None:
            self.skipTest("the dashboard sources are not in this checkout")
        text = source.read_text()
        for name, query in (
            ("GET_SHIPMENTS_LIST", GET_SHIPMENTS_LIST),
            ("GET_SHIPMENT_BADGE_COUNTS", GET_SHIPMENT_BADGE_COUNTS),
            ("GET_USER", GET_USER),
        ):
            found = re.search(rf"export const {name} = gql`(.*?)`;", text, re.S)
            self.assertIsNotNone(found, name)
            self.assertEqual(found.group(1).split(), query.split(), name)

    def test_list_returns_the_dashboard_rows(self):
        response = self.shipments(first=20)
        self.assertEqual(response.status_code, 200)
        newest_first = self.fixtures[::-1]
        cursor = lambda data: base64.b64encode(data["id"].encode()).decode()
        self.assertDictEqual(
            json.loads(response.content),
            {
                "data": {
                    "shipments": {
                        "page_info": {
                            "count": ROWS,
                            "has_next_page": True,
                            "has_previous_page": False,
                            "start_cursor": cursor(newest_first[0]),
                            "end_cursor": cursor(newest_first[19]),
                        },
                        "edges": [
                            {"node": _expected_node(data)} for data in newest_first[:20]
                        ],
                    }
                }
            },
        )

    def test_list_statement_count_does_not_grow_with_rows(self):
        five = self.capture(lambda: self.shipments(first=5))
        twenty = self.capture(lambda: self.shipments(first=20))
        self.assertEqual(len(twenty), len(five), [q["sql"][:200] for q in twenty])
        # One page SELECT and one COUNT(*); auth and settings come from cache.
        self.assertEqual(len(_statements(twenty, "shipments")), 2)
        self.assertEqual(len(twenty), 2, [q["sql"][:200] for q in twenty])

    def test_list_does_not_read_documents_or_tracker_payloads(self):
        page = next(
            sql
            for sql in _statements(self.capture(self.shipments), "shipments")
            if "COUNT(" not in sql
        )
        selected = page.split(" FROM ")[0]
        for column in ("label", "invoice", "delivery_image", "signature_image", "events"):
            # the document columns appear once, as the IS NOT NULL annotation
            self.assertIsNone(re.search(rf'"{column}"(?! IS NOT NULL)', selected), selected)

    def test_tracker_selection_and_archived_manager_keep_working(self):
        # Selecting the tracker itself lifts the deferral of its payload (no
        # per-row reload), and the unfiltered manager behind is_archived takes
        # the same trimming without a select_related to defer through.
        query = """query tracked($filter: ShipmentFilter) {
          shipments(filter: $filter) { edges { node { id tracker_id tracker { id status events { code } } } } }
        }"""
        tracked = lambda **f: self.post(
            query, "tracked", {"filter": {"first": 20, "offset": 0, **f}}
        )
        queries = self.capture(tracked)
        self.assertEqual(len(queries), 1, [q["sql"][:200] for q in queries])
        self.assertIn('"events"', queries[0]["sql"])
        nodes = [e["node"] for e in json.loads(tracked().content)["data"]["shipments"]["edges"]]
        self.assertEqual(
            [node["tracker"] and node["tracker"]["id"] for node in nodes],
            [node["tracker_id"] for node in nodes],
        )
        self.assertEqual(sum(1 for node in nodes if node["tracker"]), 11)
        self.assertEqual(len(nodes[1]["tracker"]["events"]), 12)
        archived = tracked(is_archived=True)
        self.assertEqual(archived.status_code, 200)
        self.assertEqual(json.loads(archived.content), {"data": {"shipments": {"edges": []}}})

    def test_badge_counts_never_load_rows(self):
        queries = self.capture(
            lambda: self.post(GET_SHIPMENT_BADGE_COUNTS, "shipment_badge_counts")
        )
        # Three aliases, three COUNT(*): no shipment row is fetched to answer
        # a request that only selects page_info.count.
        self.assertEqual(len(queries), 3, [q["sql"][:200] for q in queries])
        self.assertTrue(all("COUNT(" in q["sql"] for q in queries))
        response = self.post(GET_SHIPMENT_BADGE_COUNTS, "shipment_badge_counts")
        self.assertDictEqual(
            json.loads(response.content),
            {
                "data": {
                    "today": {"page_info": {"count": 5}},
                    "hold": {"page_info": {"count": 3}},
                    "review": {"page_info": {"count": 2}},
                }
            },
        )

    def test_fixed_cost_of_an_authenticated_request(self):
        # Nothing runs before a resolver: the JWT user comes from the cache.
        # GetUser's three statements (user, two permission lookups) are its own.
        queries = self.capture(lambda: self.post("query Ping { __typename }", "Ping"))
        self.assertEqual(len(queries), 0, [q["sql"][:200] for q in queries])
        queries = self.capture(lambda: self.post(GET_USER, "GetUser"))
        self.assertEqual(len(queries), 3, [q["sql"][:200] for q in queries])

    @unittest.skipUnless(os.environ.get("SHIPMENTS_LIST_PROFILE"), "opt-in measurement")
    def test_profile(self):
        """SHIPMENTS_LIST_PROFILE=1 karrio test ...test_shipments_list_cost: prints the numbers."""
        import time
        import pstats
        import cProfile

        requests = {
            "list first=20": lambda: self.shipments(first=20),
            "list first=5": lambda: self.shipments(first=5),
            "badge counts": lambda: self.post(
                GET_SHIPMENT_BADGE_COUNTS, "shipment_badge_counts"
            ),
            "GetUser": lambda: self.post(GET_USER, "GetUser"),
            "Ping": lambda: self.post("query Ping { __typename }", "Ping"),
        }
        for name, request in requests.items():
            queries = self.capture(request)
            wall, cpu = [], []
            for _ in range(60):
                started = time.perf_counter(), time.process_time()
                body = request().content
                wall.append(time.perf_counter() - started[0])
                cpu.append(time.process_time() - started[1])
            print(
                f"\n{name}: {len(queries)} queries, {len(body)} bytes, "
                f"wall {min(wall) * 1000:.1f} ms (median {sorted(wall)[30] * 1000:.1f}), "
                f"cpu {min(cpu) * 1000:.1f} ms (median {sorted(cpu)[30] * 1000:.1f})"
            )
            for q in queries:
                print(f"   {q['time']}s  {q['sql'][:160]}")
        profile = cProfile.Profile()
        profile.enable()
        for _ in range(20):
            self.shipments(first=20)
        profile.disable()
        stats = pstats.Stats(profile)
        # Our own code first (cumulative), then where the time is spent overall.
        stats.sort_stats("cumulative").print_stats(r"karrio/server/(?!.*tests/)", 25)
        stats.sort_stats("cumulative").print_stats(r"site-packages", 45)
        stats.sort_stats("tottime").print_stats(25)
