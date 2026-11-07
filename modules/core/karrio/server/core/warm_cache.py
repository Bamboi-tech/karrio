"""Shared state of the warm shipments list cache (PRDs/SHIPMENTS_WARM_LIST_CACHE.md).

``karrio.server.graph.warm_cache`` serves cached bodies tagged with the data
version kept here; ``data_changed()`` moves it from every write to a Shipment
or Tracking row (model signals, and the bulk paths that bypass them), so a
body tagged with an older version is a miss, never served.
"""

import time
import typing
import django.dispatch
from django.conf import settings
from django.core.cache import cache
from django.db import transaction

from karrio.server.core.logging import logger

VERSION_KEY = "shipments_warm:version"

# Sent after a commit moved the data version; the graph module re-warms on it.
shipments_changed = django.dispatch.Signal()


def users() -> typing.List[str]:
    return getattr(settings, "SHIPMENTS_WARM_USERS", None) or []


def enabled() -> bool:
    return bool(users())


def is_warm_user(user) -> bool:
    email = getattr(user, "email", None)
    return bool(email) and email.lower() in users()


def data_version() -> typing.Optional[int]:
    """The current data version, or None when the cache cannot answer.

    The counter starts at the epoch second, so a key lost and recreated
    never restarts below a version that bodies were tagged with.
    """
    try:
        version = cache.get(VERSION_KEY)
        if version is None:
            cache.add(VERSION_KEY, int(time.time()), None)
            version = cache.get(VERSION_KEY)
        return version
    except Exception as e:
        logger.warning("Warm cache version unavailable", error=str(e))
        return None


def bump_version() -> typing.Optional[int]:
    try:
        cache.add(VERSION_KEY, int(time.time()), None)
        return cache.incr(VERSION_KEY)
    except Exception as e:
        logger.warning("Warm cache version bump failed", error=str(e))
        return None


def data_changed(*args, **kwargs) -> None:
    """Record that shipment data changed. Usable as a post_save/post_delete
    receiver; the version moves when the surrounding transaction commits.
    """
    if not enabled():
        return

    transaction.on_commit(_bump_and_notify)


def _bump_and_notify() -> None:
    version = bump_version()

    if version is not None:
        shipments_changed.send(sender=None, version=version)
