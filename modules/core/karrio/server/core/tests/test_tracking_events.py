"""Bamboi fork: merged tracking events keep the latest one on top.

process_events re-sorts a tracker's events when new ones arrive, by their
date and time. It could not read the time Karrio itself writes
(lib.flocaltime's "%H:%M %p": "23:47 PM", "00:09 AM"), so such an event sorted
as midnight and the label's CREATED event (Karrio's own "%I:%M %p") outranked
every carrier event of that day. DPD's first scan lands around 01:00
Amsterdam, which is the label's own UTC date: from then on the Karrio
dashboard and the ERP's last event read CREATED while the parcel was on its
way (SO-Shopify-07494 from 10-10 until its delivery on 13-10; 07621 still on
15-10). The events below are the stored tracker events of SO-Shopify-07621 and
07411, T&T codes replaced.
"""

import datetime
import unittest

from karrio.core.models import TrackingEvent
from karrio.server.core.utils import default_tracking_event, process_events


def _instant(timestamp: str) -> datetime.datetime:
    return datetime.datetime.fromisoformat(timestamp.replace("Z", "+00:00"))


def _label_created(timestamp: str) -> list:
    return default_tracking_event(event_at=_instant(timestamp))


def _monta_event(code: str, status: str, timestamp: str) -> TrackingEvent:
    """An event as the Monta plugin emits it (lib.flocaltime's time shape)."""
    instant = _instant(timestamp)
    return TrackingEvent(
        date=instant.strftime("%Y-%m-%d"),
        time=instant.strftime("%H:%M %p"),
        timestamp=timestamp,
        code=code,
        description=f"{code} (05212000000001)",
        status=status,
    )


class TestTrackingEventsMerge(unittest.TestCase):
    def test_a_carrier_scan_later_that_day_goes_above_the_label(self):
        # SO-Shopify-07621: label at 07:28Z, DPD's sorting scan at 23:47Z.
        events = process_events(
            response_events=[
                _monta_event("EnRoute", "in_transit", "2026-10-12T23:47:20.000Z"),
                _monta_event("EnRoute", "in_transit", "2026-10-12T23:45:27.000Z"),
                _monta_event("Shipped", "picked_up", "2026-10-12T15:10:50.000Z"),
                _monta_event("Packing", "picked_up", "2026-10-12T15:10:50.000Z"),
            ],
            current_events=_label_created("2026-10-12T07:28:41.727Z"),
        )

        self.assertEqual(
            [(event["code"], event["time"]) for event in events],
            [
                ("EnRoute", "23:47 PM"),
                ("EnRoute", "23:45 PM"),
                ("Shipped", "15:10 PM"),
                ("Packing", "15:10 PM"),
                ("CREATED", "07:28 AM"),
            ],
        )

    def test_the_midnight_hour_sorts_after_the_evening_before(self):
        # SO-Shopify-07411: label at 14:27Z, scans at 23:41Z and 00:09Z.
        events = process_events(
            response_events=[
                _monta_event("EnRoute", "in_transit", "2026-10-13T00:09:54.000Z"),
                _monta_event("EnRoute", "in_transit", "2026-10-12T23:41:19.000Z"),
                _monta_event("Shipped", "picked_up", "2026-10-12T15:21:51.000Z"),
            ],
            current_events=_label_created("2026-10-12T14:27:06.434Z"),
        )

        self.assertEqual(
            [(event["code"], event["date"], event["time"]) for event in events],
            [
                ("EnRoute", "2026-10-13", "00:09 AM"),
                ("EnRoute", "2026-10-12", "23:41 PM"),
                ("Shipped", "2026-10-12", "15:21 PM"),
                ("CREATED", "2026-10-12", "02:27 PM"),
            ],
        )
