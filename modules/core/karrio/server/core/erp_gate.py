"""ERP label gate (Bamboi fork).

The dashboard's Buy Label used to walk around every ERP business gate
(hold/refund/address/mode — scenario row 42: a real label was bought for an
order that was ON_HOLD and self_delivery). Every purchase of an ERP-linked
shipment now asks the ERP first; the ERP answers with the exact same
composite gate its own Create Shipping Label button runs.

ERP-linked means the shipment metadata carries the keys the ERP sync stamps
(``karrio_shipment`` / ``sales_order``). Standalone Karrio shipments are not
gated — the fork must stay usable without an ERP.

Doctrine: fail closed. A blocked purchase and an unanswerable ERP both stop
the purchase; only the error message differs. A wrongly bought label costs
money and a manual cancellation in the Monta portal, while an ERP outage is
rare and loud.
"""

import re
import json
import logging
import requests

from decouple import config
from django.conf import settings
from django.core.cache import cache

from karrio.server.core.exceptions import APIException

logger = logging.getLogger(__name__)

ERP_LINK_KEYS = ("karrio_shipment", "sales_order")
GATE_PATH = "/api/method/karrio_shipping.api.gates.assert_label_allowed"


class ERPRefusal(APIException):
    """The ERP answered and said no.

    Its own reason is relayed unchanged, so the operator reads in the
    dashboard exactly what the ERP button would have shown. A refusal is the
    gate doing its job, not a fault: Sentry drops this type (settings.apm,
    SENTRY_EXPECTED_EXCEPTIONS). The 424s for an unreachable or unconfigured
    ERP stay plain APIException and keep reporting, because that is the
    outage the doctrine above calls rare and loud.
    """


def _erp_timeout():
    """``(connect, read)`` for every ERP call.

    Connecting is fast or broken, so it stays short. Reading waits on Frappe
    actually running the method, a document save plus its hooks under a busy
    gunicorn, which overran the old flat 5 s on 2026-08-31 while the ERP was
    merely slow (KARRIO-PROD-PYTHON-DJANGO-N, mark_picked).
    """
    return (
        getattr(settings, "ERP_GATE_CONNECT_TIMEOUT", 5),
        getattr(settings, "ERP_GATE_TIMEOUT", 30),
    )


def is_erp_linked(shipment) -> bool:
    metadata = getattr(shipment, "metadata", None) or {}
    return any(key in metadata for key in ERP_LINK_KEYS)


def assert_erp_label_allowed(shipment) -> None:
    """Raise unless the ERP allows a label for this shipment right now.

    No-op for shipments without ERP metadata. For ERP-linked shipments a
    missing configuration, an unreachable ERP and an explicit refusal all
    raise — the refusal carries the ERP's own reason so the operator reads
    the same message the ERP button would show.
    """
    if not is_erp_linked(shipment):
        return

    url = getattr(settings, "ERP_GATE_URL", None)
    token = getattr(settings, "ERP_GATE_TOKEN", None)
    if not url or not token:
        raise APIException(
            "This shipment is managed by ERP but the ERP label gate is not configured "
            "(ERP_GATE_URL / ERP_GATE_TOKEN) — buy the label via the ERP button instead.",
            code="erp_gate_unconfigured",
            status_code=424,
        )

    metadata = shipment.metadata or {}
    try:
        response = requests.post(
            url.rstrip("/") + GATE_PATH,
            json={
                "karrio_shipment_id": shipment.id,
                "karrio_shipment": metadata.get("karrio_shipment"),
                "sales_order": metadata.get("sales_order"),
            },
            headers={"Authorization": f"token {token}"},
            timeout=_erp_timeout(),
        )
        response.raise_for_status()
        result = (response.json() or {}).get("message") or {}
    except requests.RequestException as error:
        logger.warning("ERP label gate unreachable for %s: %s", shipment.id, error)
        raise APIException(
            "ERP label gate unreachable — the purchase is refused to be safe. "
            "Try again in a moment or buy the label via the ERP button.",
            code="erp_gate_unreachable",
            status_code=424,
        )

    if not result.get("allowed"):
        raise ERPRefusal(
            result.get("reason") or "ERP refused the label purchase for this shipment.",
            code="erp_gate_blocked",
            status_code=409,
        )


# ---------------------------------------------------------------------------
# ERP shipment actions (Mark Picked / Mark Out for Delivery / Mark Shipped /
# Record delivery outcome / Cancel — each status step with its undo)
# ---------------------------------------------------------------------------

# Whitelisted @frappe.whitelist() doc methods on the ERP's Karrio Shipment,
# mapped to the argument names each one accepts. This mapping is the only
# source of truth: an action outside it, or an argument name outside its
# tuple, never reaches the ERP. An empty tuple means the method takes no
# arguments and the caller may not send any.
#
# The relay adds no logic of its own beyond that: the ERP enforces its own
# gates (assert_order_not_blocked, assert_self_delivery_allowed) and mirrors
# the resulting erp_status back onto this shipment's metadata by itself.
ERP_SHIPMENT_ACTIONS = {
    "mark_picked": (),
    "unmark_picked": (),
    "mark_out_for_delivery": (),
    "unmark_out_for_delivery": (),
    "mark_shipped": (),
    "unmark_shipped": (),
    "mark_delivered": (),
    "unmark_delivered": (),
    "cancel_shipment": (),
    "record_delivery_outcome": ("outcome", "note"),
    # Overrules Google's hint via the ERP's own Confirm-as-correct door: the
    # ERP re-validates live and refuses anything but a Suspect verdict, so
    # the relay adds no judgement of its own.
    "confirm_address": ("reason",),
    "undo_delivery_outcome": (),
}
RUN_DOC_METHOD_PATH = "/api/method/frappe.handler.run_doc_method"


def _erp_error_message(response) -> str:
    """Best-effort human message out of a Frappe error response."""
    try:
        body = response.json() or {}
        messages = json.loads(body.get("_server_messages") or "[]")
        for raw in messages:
            message = (json.loads(raw) or {}).get("message")
            if message:
                # Frappe messages may carry markup; the dashboard shows text.
                return re.sub(r"<[^>]+>", "", message)
        if body.get("exception"):
            return str(body["exception"]).split(":", 1)[-1].strip()
    except (ValueError, TypeError):
        pass
    return "ERP refused the action."


def run_erp_shipment_action(shipment, action: str, args: dict = None) -> dict:
    """Relay one warehouse action to the ERP's Karrio Shipment document.

    ``args`` carries the method arguments for the actions that take any
    (``record_delivery_outcome``); it is validated against
    ``ERP_SHIPMENT_ACTIONS`` so a caller can never reach an ERP method or an
    ERP argument the fork did not whitelist.

    Returns ``{"message": <ERP's own success message>}``, plus whatever extra
    keys the ERP method chose to return next to its message. Raises with the
    ERP's refusal (hold, wrong status, wrong mode) or on transport failure —
    same fail-closed doctrine as the label gate.
    """
    allowed_args = ERP_SHIPMENT_ACTIONS.get(action)
    if allowed_args is None:
        raise APIException(
            "Unknown ERP shipment action.",
            code="erp_action_unknown",
            status_code=400,
        )

    if args is not None and not isinstance(args, dict):
        raise APIException(
            "ERP shipment action arguments must be a JSON object.",
            code="erp_action_invalid_args",
            status_code=400,
        )

    arguments = {key: value for key, value in (args or {}).items()}
    unexpected = sorted(set(arguments) - set(allowed_args))
    if unexpected:
        raise APIException(
            f"Unexpected argument(s) for ERP shipment action '{action}': "
            f"{', '.join(unexpected)}.",
            code="erp_action_invalid_args",
            status_code=400,
        )

    metadata = getattr(shipment, "metadata", None) or {}
    docname = metadata.get("karrio_shipment")
    if not docname:
        raise APIException(
            "This shipment is not linked to an ERP shipment.",
            code="erp_action_unlinked",
            status_code=409,
        )

    url = getattr(settings, "ERP_GATE_URL", None)
    token = getattr(settings, "ERP_GATE_TOKEN", None)
    if not url or not token:
        raise APIException(
            "The ERP link is not configured (ERP_GATE_URL / ERP_GATE_TOKEN) — "
            "run this action from the ERP instead.",
            code="erp_gate_unconfigured",
            status_code=424,
        )

    payload = {"dt": "Karrio Shipment", "dn": docname, "method": action}
    if allowed_args:
        # frappe.handler.run_doc_method splats a dict ``args`` into keyword
        # arguments; sending it for every argument-taking action keeps the
        # ERP method on that kwargs path instead of the positional fallback.
        payload["args"] = arguments

    try:
        response = requests.post(
            url.rstrip("/") + RUN_DOC_METHOD_PATH,
            json=payload,
            headers={"Authorization": f"token {token}"},
            timeout=_erp_timeout(),
        )
    except requests.ReadTimeout as error:
        # The request reached the ERP and the ERP went quiet: Frappe may well
        # have finished the action after we stopped listening. Saying
        # "unreachable" here sent the operator straight into a retry that the
        # ERP then refused for being in the wrong status.
        logger.warning("ERP action %s timed out for %s: %s", action, shipment.id, error)
        raise APIException(
            "The ERP did not answer in time — the action may still have gone through. "
            "Reload the shipment before retrying, or run it from the ERP.",
            code="erp_gate_timeout",
            status_code=424,
        )
    except requests.RequestException as error:
        logger.warning(
            "ERP action %s unreachable for %s: %s", action, shipment.id, error
        )
        raise APIException(
            "ERP unreachable — try again in a moment or run this action from the ERP.",
            code="erp_gate_unreachable",
            status_code=424,
        )

    if response.status_code >= 400:
        raise ERPRefusal(
            _erp_error_message(response),
            code="erp_action_refused",
            status_code=409,
        )

    body = (response.json() or {}).get("message")
    if isinstance(body, dict):
        # An action that has more to say than a sentence (confirm-address
        # hands back the id of the draft the ERP rebuilt, so the dashboard
        # can open it) returns ``{"message": ..., <extra keys>}``. The extra
        # keys ride along untouched; ``message`` stays a string so every
        # toast keeps working.
        extra = {key: value for key, value in body.items() if key != "message"}
        return {"message": body.get("message") or "Done.", **extra}
    return {"message": body or "Done."}


# ---------------------------------------------------------------------------
# ERP feature flags (list / toggle)
# ---------------------------------------------------------------------------

# Whitelisted @frappe.whitelist() module methods — the only feature-flag
# surface the fork exposes. Same doctrine as the shipment actions: the ERP
# owns the flags and their validation; the relay only carries them.
FEATURES_LIST_PATH = "/api/method/karrio_shipping.api.features.list_features"
FEATURES_SET_PATH = "/api/method/karrio_shipping.api.features.set_feature"


# The feature registry "barely changes" (dashboard hook), yet every page
# mount used to pay one synchronous ERP round trip for it while holding one
# of the API's request slots. The listing is therefore cached process-wide
# for ERP_FEATURES_CACHE_TTL seconds, read with a short ERP_FEATURES_TIMEOUT
# and, when the ERP cannot answer, served from the last value it did give
# (kept for a week under a second key). A toggle drops the fresh copy and
# patches the stale one so the dashboard never reads a pre-toggle list.
FEATURES_CACHE_KEY = "erp_features:current"
FEATURES_LAST_KNOWN_CACHE_KEY = "erp_features:last_known"
FEATURES_LAST_KNOWN_TTL = 7 * 24 * 3600


def _features_cache_ttl() -> int:
    return getattr(
        settings,
        "ERP_FEATURES_CACHE_TTL",
        config("ERP_FEATURES_CACHE_TTL", default=120, cast=int),
    )


def _features_timeout():
    """``(connect, read)`` for the feature listing only.

    The listing sits on the dashboard's read path, so it may not wait the
    30 s a document method is allowed: a slow Frappe answers from cache.
    """
    connect, _ = _erp_timeout()
    return (
        connect,
        getattr(
            settings,
            "ERP_FEATURES_TIMEOUT",
            config("ERP_FEATURES_TIMEOUT", default=3, cast=int),
        ),
    )


def _post_erp_method(path: str, payload: dict, label: str, timeout=None):
    """POST one whitelisted Frappe method and return the unwrapped ``message``.

    Same fail-closed doctrine as the shipment relays: missing configuration
    and an unreachable ERP raise 424, an ERP refusal raises 409 carrying the
    ERP's own message. ``timeout`` overrides the default ``(connect, read)``
    pair for callers that may not wait the full read budget.
    """
    url = getattr(settings, "ERP_GATE_URL", None)
    token = getattr(settings, "ERP_GATE_TOKEN", None)
    if not url or not token:
        raise APIException(
            "The ERP link is not configured (ERP_GATE_URL / ERP_GATE_TOKEN) — "
            "manage this from the ERP instead.",
            code="erp_gate_unconfigured",
            status_code=424,
        )

    try:
        response = requests.post(
            url.rstrip("/") + path,
            json=payload,
            headers={"Authorization": f"token {token}"},
            timeout=timeout or _erp_timeout(),
        )
    except requests.RequestException as error:
        logger.warning("ERP %s unreachable: %s", label, error)
        raise APIException(
            "ERP unreachable — try again in a moment.",
            code="erp_gate_unreachable",
            status_code=424,
        )

    if response.status_code >= 400:
        raise ERPRefusal(
            _erp_error_message(response),
            code="erp_action_refused",
            status_code=409,
        )

    return (response.json() or {}).get("message")


def run_erp_features_list() -> dict:
    """Relay the ERP's feature-flag listing; returns ``{"features": [...]}``.

    Served from cache for ERP_FEATURES_CACHE_TTL seconds. When the ERP
    cannot answer within ERP_FEATURES_TIMEOUT (or refuses), the last value
    it did give is returned with a warning; only when there is no such
    value does the failure surface, so the dashboard falls back to its own
    defaults exactly as before. A missing configuration is never masked.
    """
    cached = cache.get(FEATURES_CACHE_KEY)
    if cached is not None:
        return cached

    try:
        message = _post_erp_method(
            FEATURES_LIST_PATH, {}, "features list", timeout=_features_timeout()
        )
    except APIException as error:
        last_known = (
            None
            if error.code == "erp_gate_unconfigured"
            else cache.get(FEATURES_LAST_KNOWN_CACHE_KEY)
        )
        if last_known is None:
            raise
        logger.warning(
            "ERP features list unavailable (%s); serving last known value",
            error.code,
        )
        return last_known

    features = message.get("features") if isinstance(message, dict) else message
    result = {"features": features or []}
    cache.set(FEATURES_CACHE_KEY, result, _features_cache_ttl())
    cache.set(FEATURES_LAST_KNOWN_CACHE_KEY, result, FEATURES_LAST_KNOWN_TTL)
    return result


def _remember_feature_toggle(key: str, enabled: bool) -> None:
    """Drop the fresh listing and patch the last-known one after a toggle."""
    cache.delete(FEATURES_CACHE_KEY)
    last_known = cache.get(FEATURES_LAST_KNOWN_CACHE_KEY)
    if last_known is None:
        return
    cache.set(
        FEATURES_LAST_KNOWN_CACHE_KEY,
        {
            "features": [
                (
                    {**feature, "enabled": enabled}
                    if isinstance(feature, dict) and feature.get("key") == key
                    else feature
                )
                for feature in last_known.get("features") or []
            ]
        },
        FEATURES_LAST_KNOWN_TTL,
    )


def run_erp_features_set(key, enabled) -> dict:
    """Relay one feature toggle to the ERP; returns ``{"key", "enabled"}``.

    The ERP validates the key against its own registry — an unknown key is
    its refusal to surface, not ours. Only the payload shape is checked here
    so a malformed request never reaches the ERP.
    """
    if not isinstance(key, str) or not key:
        raise APIException(
            "Feature flag 'key' must be a non-empty string.",
            code="erp_feature_invalid",
            status_code=400,
        )
    if not isinstance(enabled, bool):
        raise APIException(
            "Feature flag 'enabled' must be a boolean.",
            code="erp_feature_invalid",
            status_code=400,
        )

    message = _post_erp_method(
        FEATURES_SET_PATH, {"key": key, "enabled": enabled}, "feature set"
    )
    result = message if isinstance(message, dict) else {}
    outcome = {"key": result.get("key", key), "enabled": result.get("enabled", enabled)}
    _remember_feature_toggle(outcome["key"], outcome["enabled"])
    return outcome
