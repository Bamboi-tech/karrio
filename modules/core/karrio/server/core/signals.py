from django.conf import settings
from django.dispatch import receiver
from django.contrib.auth import get_user_model
from django.db.models import signals as model_signals
from constance import config
from constance.signals import config_updated
from django.core.signals import request_started

from karrio.server.core.logging import logger


def register_signals():
    config_updated.connect(constance_updated)
    request_started.connect(initialize_settings)
    model_signals.post_save.connect(user_changed, sender=get_user_model())
    model_signals.post_delete.connect(user_changed, sender=get_user_model())

    logger.info("Signal registration complete", module="karrio.core")


def user_changed(sender, instance, **_kwargs):
    """Drop the JWT user cache entry so a deactivation or password change
    is honoured on the next request rather than after the TTL."""
    from karrio.server.core.authentication import invalidate_jwt_user_cache

    invalidate_jwt_user_cache(instance.pk)


def initialize_settings(_sender=None, **_kwargs):
    """Initialize Django settings from constance on first request."""
    if getattr(initialize_settings, "has_run", False):
        return

    try:
        update_settings(config)
        initialize_settings.has_run = True
    except Exception as e:
        logger.error("Failed to initialize settings", error=str(e))


@receiver(config_updated)
def constance_updated(sender, **_kwargs):
    from karrio.server.core.dataunits import bump_references_version

    update_settings(sender)
    bump_references_version()


def _batch_fetch_constance(keys: list) -> dict:
    """Fetch all constance values in a single query.

    Returns a dict of {key: deserialized_value} for all keys found in the DB.
    Falls back to CONSTANCE_CONFIG defaults for missing keys.
    """
    try:
        from constance.models import Constance

        prefix = getattr(settings, "CONSTANCE_DATABASE_PREFIX", "")
        db_keys = [f"{prefix}{k}" for k in keys]

        rows = Constance.objects.filter(key__in=db_keys).values_list("key", "value")
        raw_map = {k.removeprefix(prefix): v for k, v in rows}

        # Deserialize using pickle (constance default) and fall back to config defaults
        import pickle  # nosec — mirrors constance's own pickle serialization for DB-stored values

        result = {}
        for key in keys:
            if key in raw_map and raw_map[key] is not None:
                try:
                    result[key] = pickle.loads(raw_map[key])  # nosec B301 — constance stores values as pickle, same pattern as constance internals
                except Exception:
                    result[key] = settings.CONSTANCE_CONFIG[key][0]
            else:
                result[key] = settings.CONSTANCE_CONFIG[key][0]

        return result
    except Exception:
        # Fallback: table doesn't exist yet (migrations not run)
        return {}


def update_settings(current):
    """Sync constance values to Django settings.

    Uses a single batch query instead of per-key lookups to avoid N+1.
    Falls back to individual getattr() if batch fetch fails.
    """
    keys = [k for k in settings.CONSTANCE_CONFIG.keys() if hasattr(settings, k)]
    email_keys = ["EMAIL_HOST", "EMAIL_HOST_USER"]
    all_keys = list(set(keys + email_keys))

    # Try batch fetch first (1 query instead of N)
    values = _batch_fetch_constance(all_keys)

    if values:
        for key in keys:
            if key in values:
                setattr(settings, key, values[key])

        settings.EMAIL_ENABLED = all(
            values.get(k) not in (None, "")
            for k in email_keys
        )
        return

    # Fallback: individual lookups (e.g., during tests or when table doesn't exist)
    for key in keys:
        try:
            setattr(settings, key, getattr(current, key))
        except Exception:
            pass

    try:
        settings.EMAIL_ENABLED = all(
            cfg not in (None, "")
            for cfg in [current.EMAIL_HOST, current.EMAIL_HOST_USER]
        )
    except Exception:
        settings.EMAIL_ENABLED = False
