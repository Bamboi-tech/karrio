"""Background warming of the shipments list response cache.

``warm_shipments_lists`` runs, debounced, after shipment data changed
(``warm_cache.schedule``); ``warm_shipments_lists_periodic`` catches what a
worker restart or a cache eviction lost. Both only execute sets whose body
is behind the data version. ``run_huey`` autodiscovers this module.
"""

from django.core.cache import cache
from huey import crontab
from huey.contrib.djhuey import db_task, db_periodic_task, HUEY as huey_instance
from huey.exceptions import TaskLockedException

import karrio.server.core.warm_cache as core
import karrio.server.graph.warm_cache as warm_cache
from karrio.server.core.logging import logger
from karrio.server.core.telemetry import with_task_telemetry

LOCK = "warm_shipments_lists"


def _warm() -> int:
    with huey_instance.lock_task(LOCK):
        # Changes from here on schedule a new run; this one reads the version
        # when it starts, so a later change is never folded into it.
        cache.delete(warm_cache.PENDING_KEY)
        stored = warm_cache.warm()

    logger.info("Warmed shipments lists", stored=stored)
    return stored


@db_task()
@with_task_telemetry("warm_shipments_lists")
def warm_shipments_lists():
    try:
        return _warm()
    except TaskLockedException:
        # A run is in flight with an older version: try again after it.
        warm_shipments_lists.schedule(delay=warm_cache.DEBOUNCE_SECONDS)
        return None


@db_periodic_task(crontab(minute="*/5"))
@with_task_telemetry("warm_shipments_lists_periodic")
def warm_shipments_lists_periodic():
    if not core.enabled():
        return None
    try:
        return _warm()
    except TaskLockedException:
        return None
