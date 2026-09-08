"""The SDK tracing table grows with every carrier call; the daily retention
task must prune only the rows older than TRACING_RETENTION_DAYS."""

import datetime
from django.utils import timezone

from karrio.server.core.tests import APITestCase
import karrio.server.tracing.models as tracing
from karrio.server.events.task_definitions.base import archiving


class TestTracingRetention(APITestCase):
    def _record(self, age_days: int):
        record = tracing.TracingRecord.objects.create(
            key="carrier.request",
            record={"url": "https://carrier.test"},
            timestamp=timezone.now().timestamp(),
            meta={"object_id": "shp_test"},
            test_mode=True,
            created_by=self.user,
        )
        tracing.TracingRecord.objects.filter(pk=record.pk).update(
            created_at=timezone.now() - datetime.timedelta(days=age_days)
        )
        return record

    def test_prunes_only_records_past_the_retention_window(self):
        stale = [self._record(15), self._record(40)]
        fresh = [self._record(0), self._record(13)]

        deleted = archiving.run_tracing_retention(14)

        self.assertEqual(deleted, 2)
        self.assertFalse(
            tracing.TracingRecord.objects.filter(pk__in=[r.pk for r in stale]).exists()
        )
        self.assertEqual(
            tracing.TracingRecord.objects.filter(pk__in=[r.pk for r in fresh]).count(),
            2,
        )

    def test_nothing_to_prune_is_a_quiet_noop(self):
        self._record(1)
        self.assertEqual(archiving.run_tracing_retention(14), 0)
        self.assertEqual(tracing.TracingRecord.objects.count(), 1)
