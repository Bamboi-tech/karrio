import logging
from django.db import (
    InterfaceError,
    OperationalError,
    close_old_connections,
    connections,
    models,
)
from django.utils import timezone

logger = logging.getLogger(__name__)


def register_huey_signals():
    """Register Huey signal handlers to track task execution lifecycle.

    Uses split create/update pattern instead of update_or_create to avoid
    SELECT ... FOR UPDATE lock contention when multiple tasks are enqueued
    in rapid succession (e.g. background_trackers_update dispatching
    per-carrier batches).
    """
    try:
        from huey.signals import (
            SIGNAL_ENQUEUED,
            SIGNAL_EXECUTING,
            SIGNAL_COMPLETE,
            SIGNAL_ERROR,
            SIGNAL_RETRYING,
            SIGNAL_REVOKED,
            SIGNAL_EXPIRED,
        )
        from huey.contrib.djhuey import HUEY as huey_instance
    except ImportError:
        logger.debug("Huey not available, skipping signal registration")
        return

    def _record(signal, task, exc=None):
        try:
            from karrio.server.admin.worker.models import TaskExecution

            now = timezone.now()
            task_id = task.id
            task_name = task.name or "unknown"

            SIGNAL_STATUS_MAP = {
                SIGNAL_ENQUEUED: "queued",
                SIGNAL_EXECUTING: "executing",
                SIGNAL_COMPLETE: "complete",
                SIGNAL_ERROR: "error",
                SIGNAL_RETRYING: "retrying",
                SIGNAL_REVOKED: "revoked",
                SIGNAL_EXPIRED: "expired",
            }

            status = SIGNAL_STATUS_MAP.get(signal, signal)

            if signal == SIGNAL_RETRYING:
                TaskExecution.objects.filter(task_id=task_id).update(
                    retries=models.F("retries") + 1,
                    status="retrying",
                )
                return

            # ENQUEUED: create a new record (no SELECT FOR UPDATE needed)
            if signal == SIGNAL_ENQUEUED:
                TaskExecution.objects.create(
                    task_id=task_id,
                    task_name=task_name,
                    status=status,
                    queued_at=now,
                    args_summary=str(task.args)[:500] if task.args else None,
                )
                return

            # All other signals: lightweight UPDATE (no row lock)
            updates = {"status": status, "task_name": task_name}

            if signal == SIGNAL_EXECUTING:
                updates["started_at"] = now

            elif signal in (SIGNAL_COMPLETE, SIGNAL_ERROR, SIGNAL_REVOKED, SIGNAL_EXPIRED):
                updates["completed_at"] = now

            if signal == SIGNAL_ERROR and exc:
                updates["error"] = str(exc)[:2000]

            # Calculate duration inline to avoid a second UPDATE round-trip
            if signal in (SIGNAL_COMPLETE, SIGNAL_ERROR):
                obj = TaskExecution.objects.filter(task_id=task_id).values("started_at").first()
                if obj and obj["started_at"]:
                    updates["duration_ms"] = int(
                        (now - obj["started_at"]).total_seconds() * 1000
                    )

            TaskExecution.objects.filter(task_id=task_id).update(**updates)

        except (InterfaceError, OperationalError):
            # Connection errors go to the receiver, which may reconnect and retry.
            raise

        except Exception:
            # Handle duplicate records from race conditions on ENQUEUED
            try:
                from karrio.server.admin.worker.models import TaskExecution

                if signal == SIGNAL_ENQUEUED:
                    # Duplicate task_id — just update the existing record
                    TaskExecution.objects.filter(task_id=task_id).update(
                        task_name=task_name,
                        status="queued",
                        queued_at=now,
                        args_summary=str(task.args)[:500] if task.args else None,
                    )
                    return
            except Exception:
                pass

            logger.exception("Failed to record task signal")

    @huey_instance.signal(
        SIGNAL_ENQUEUED,
        SIGNAL_EXECUTING,
        SIGNAL_COMPLETE,
        SIGNAL_ERROR,
        SIGNAL_RETRYING,
        SIGNAL_REVOKED,
        SIGNAL_EXPIRED,
    )
    def task_signal_handler(signal, task, exc=None):
        try:
            return _record(signal, task, exc)
        except (InterfaceError, OperationalError) as error:
            if not _reset_connections_for_retry():
                logger.warning(
                    "Task signal not recorded inside a transaction after database error: %s",
                    error,
                )
                return
            logger.warning("Retrying task signal after database error: %s", error)

        try:
            _record(signal, task, exc)
        except (InterfaceError, OperationalError):
            logger.exception("Failed to record task signal")


def _reset_connections_for_retry():
    """Let Django drop this thread's unusable or obsolete connections before a retry.

    Huey runs signal handlers outside Django's request cycle: the consumer's
    scheduler thread enqueues periodic tasks and is never wrapped by djhuey's
    close_db, so nothing else ever drops a connection the database server
    closed. Like the close_old_connections() Django runs around a request, this
    also closes healthy connections past CONN_MAX_AGE and keeps usable ones open,
    so True means "safe to retry", not "a connection was closed".

    Returns False and touches nothing when any connection of this thread is in
    a transaction: closing it would roll back the caller's work (post_save
    handlers enqueue notify_webhooks from atomic serializers).
    """
    if any(conn.in_atomic_block for conn in connections.all(initialized_only=True)):
        return False

    close_old_connections()
    return True
