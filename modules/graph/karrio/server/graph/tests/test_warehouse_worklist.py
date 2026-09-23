"""Warehouse filtering must happen before pagination and count calculation."""
import datetime
from unittest.mock import patch
from karrio.server.graph.tests.base import GraphTestCase
import karrio.server.manager.models as manager

QUERY = '''query worklist($filter: ShipmentFilter) {
  shipments(filter: $filter) { page_info { count has_next_page } edges { node { id } } }
}'''


class TestWarehouseWorklist(GraphTestCase):
    def shipment(self, metadata=None, status="draft"):
        return manager.Shipment.objects.create(
            created_by=self.user, status=status, test_mode=False,
            payment={"currency": "EUR", "paid_by": "sender"}, metadata=metadata or {},
        )

    def page(self, view="today", **pagination):
        response = self.query(QUERY, operation_name="worklist", variables={
            "filter": {"warehouse_view": view, "first": 50, **pagination},
        })
        self.assertIsNone(response.data.get("errors"), response.data)
        self.assertResponseNoErrors(response)
        return response.data["data"]["shipments"]

    @patch("karrio.server.core.filters.timezone.now")
    def test_filter_order_count_and_pagination(self, now):
        now.return_value = datetime.datetime(2026, 9, 8, 22, 30, tzinfo=datetime.timezone.utc)
        missing = self.shipment()
        overdue = self.shipment({"print_date": "2026-09-01T12:00:00Z"})
        due = self.shipment({"print_date": "2026-09-09"})
        future = self.shipment({"print_date": "2026-09-10"})
        for metadata in (
            {"shopify_hold": False}, {"address_review_required": None},
            *({"erp_status": status} for status in (
                "Picked", "Out for Delivery", "Delivered", "Delivery Failed", "Returned", "Cancelled",
            )),
        ):
            self.shipment(metadata)
        self.shipment(status="created")
        page = self.page(first=2)
        self.assertEqual(page["page_info"], {"count": 3, "has_next_page": True})
        self.assertEqual([e["node"]["id"] for e in page["edges"]], [missing.id, overdue.id])
        self.assertEqual(self.page(offset=2)["edges"][0]["node"]["id"], due.id)
        self.assertEqual(self.page("planned")["edges"][0]["node"]["id"], future.id)
        self.assertEqual(self.page("complete")["page_info"]["count"], 4)

    def test_picked_view_counts_only_rows_on_the_card(self):
        # Seen live 23-09: 29 labeled rows, but the footer said 39 because
        # ten Monta drafts (nine on hold) were counted, then hidden.
        expected = {
            self.shipment(status="created").id,
            self.shipment({"erp_status": "Label Created"}, status="created").id,
            # Own delivery never buys a label: its picked row stays a draft.
            self.shipment({"erp_status": "Picked", "fulfilment_mode": "self_delivery"}).id,
        }
        for metadata in (
            {}, {"erp_status": "Synced"}, {"shopify_hold": "1", "erp_status": "Synced"},
            {"erp_status": "Out for Delivery"}, {"erp_status": "picked"},
        ):
            self.shipment(metadata)
        self.shipment({"erp_status": "Picked"}, status="in_transit")
        first = self.page("picked", first=2)
        rest = self.page("picked", offset=2)
        self.assertEqual(first["page_info"], {"count": 3, "has_next_page": True})
        self.assertEqual(len(first["edges"]), 2)
        self.assertEqual(
            {e["node"]["id"] for e in first["edges"] + rest["edges"]}, expected
        )
        # The dashboard sends the card's real statuses along; same rows.
        both = self.query(QUERY, operation_name="worklist", variables={"filter": {
            "warehouse_view": "picked", "status": ["created", "draft"], "first": 50,
        }})
        self.assertResponseNoErrors(both)
        self.assertEqual(both.data["data"]["shipments"]["page_info"]["count"], 3)

    def test_invalid_dates_and_null_metadata_stay_visible(self):
        for value in (None, False, 123, "", "not-a-date"):
            self.shipment({"print_date": value})
        self.assertEqual(self.page()["page_info"]["count"], 5)

    def test_badge_aliases_use_same_exact_count(self):
        self.shipment()
        self.shipment({"shopify_hold": "1"})
        response = self.query('''query counts {
          today: shipments(filter: {warehouse_view: "today", first: 1}) { page_info { count } }
          hold: shipments(filter: {status: [draft], metadata_key: "shopify_hold", first: 1}) { page_info { count } }
        }''', operation_name="counts")
        self.assertIsNone(response.data.get("errors"), response.data)
        self.assertResponseNoErrors(response)
        self.assertEqual(response.data["data"]["today"]["page_info"]["count"], 1)
        self.assertEqual(response.data["data"]["hold"]["page_info"]["count"], 1)
