import uuid
import types
import contextlib
from unittest import mock

from django.db import connections, router, transaction
from django.test import TransactionTestCase
from huey import signals as huey_signals
from huey.contrib.djhuey import HUEY

from karrio.server.admin.worker.models import TaskExecution

SIGNALS_LOGGER = "karrio.server.admin.worker.signals"


def _task():
    return types.SimpleNamespace(id=str(uuid.uuid4()), name="test_task", args=())


def _connection():
    return connections[router.db_for_write(TaskExecution)]


def _send(signal, task):
    """Dispatch like huey's _emit, but let exceptions surface: the receiver
    must never raise."""
    HUEY._signal.send(signal, task)


@contextlib.contextmanager
def _dropped_connection(error, revive_on_close=True):
    """Make the connection behave like one the database server dropped: every
    query fails with the driver's `error` until Django closes the connection
    (or for good, with revive_on_close=False). Counts the failed queries."""
    connection = _connection()
    state = {"dead": True, "failed_queries": 0}
    create_cursor = connection.create_cursor
    close = connection.close

    def dead_create_cursor(*args, **kwargs):
        if state["dead"]:
            state["failed_queries"] += 1
            raise error("connection already closed")
        return create_cursor(*args, **kwargs)

    def close_connection():
        if revive_on_close:
            state["dead"] = False
        return close()

    with (
        mock.patch.object(connection, "create_cursor", dead_create_cursor),
        mock.patch.object(connection, "is_usable", lambda: not state["dead"]),
        mock.patch.object(connection, "close", close_connection),
    ):
        yield state


class TestWorkerTaskSignals(TransactionTestCase):
    """The huey consumer's scheduler thread enqueues periodic tasks outside
    Django's request cycle, so nothing else discards its connection when the
    database drops it (KARRIO-PROD-PYTHON-DJANGO-19). TransactionTestCase: the
    scheduler thread is never inside a transaction either."""

    def test_enqueued_signal_recovers_from_dropped_connection(self):
        database = _connection().Database

        for error in (database.InterfaceError, database.OperationalError):
            with self.subTest(error=error.__name__):
                task = _task()

                with _dropped_connection(error) as dropped:
                    with self.assertNoLogs(SIGNALS_LOGGER, level="ERROR"):
                        _send(huey_signals.SIGNAL_ENQUEUED, task)

                self.assertFalse(dropped["dead"])
                self.assertEqual(
                    TaskExecution.objects.get(task_id=task.id).status, "queued"
                )

    def test_executing_signal_recovers_from_dropped_connection(self):
        task = _task()
        TaskExecution.objects.create(
            task_id=task.id, task_name=task.name, status="queued"
        )

        with _dropped_connection(_connection().Database.InterfaceError):
            with self.assertNoLogs(SIGNALS_LOGGER, level="ERROR"):
                _send(huey_signals.SIGNAL_EXECUTING, task)

        record = TaskExecution.objects.get(task_id=task.id)
        self.assertEqual(record.status, "executing")
        self.assertIsNotNone(record.started_at)

    def test_connection_that_stays_dead_is_retried_once(self):
        """Each attempt to record ENQUEUED issues one query, so two failed
        queries mean one retry and no retry loop."""
        task = _task()

        with (
            _dropped_connection(
                _connection().Database.InterfaceError, revive_on_close=False
            ) as dropped,
            mock.patch(f"{SIGNALS_LOGGER}.logger") as logger,
        ):
            _send(huey_signals.SIGNAL_ENQUEUED, task)

        self.assertEqual(dropped["failed_queries"], 2)
        logger.warning.assert_called_once_with(
            "Retrying task signal after database error: %s", mock.ANY
        )
        logger.exception.assert_called_once_with("Failed to record task signal")
        self.assertFalse(TaskExecution.objects.filter(task_id=task.id).exists())

    def test_dropped_connection_inside_transaction_is_left_open(self):
        """post_save handlers enqueue notify_webhooks from atomic serializers.
        Closing the connection there would roll back the caller's transaction,
        so the handler must give up instead of reconnecting. The caller's own
        next query fails with the same error, so this is a warning only."""
        task = _task()

        with transaction.atomic(using=_connection().alias):
            with (
                _dropped_connection(_connection().Database.InterfaceError) as dropped,
                mock.patch(f"{SIGNALS_LOGGER}.logger") as logger,
            ):
                _send(huey_signals.SIGNAL_ENQUEUED, task)

            self.assertTrue(dropped["dead"])
            self.assertEqual(dropped["failed_queries"], 1)
            self.assertFalse(_connection().closed_in_transaction)

        logger.warning.assert_called_once_with(
            "Task signal not recorded inside a transaction after database error: %s",
            mock.ANY,
        )
        logger.exception.assert_not_called()
        self.assertFalse(TaskExecution.objects.filter(task_id=task.id).exists())
