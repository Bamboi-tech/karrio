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

from django.conf import settings

from karrio.server.core.exceptions import APIException

logger = logging.getLogger(__name__)

ERP_LINK_KEYS = ("karrio_shipment", "sales_order")
GATE_PATH = "/api/method/karrio_shipping.api.gates.assert_label_allowed"


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
            timeout=getattr(settings, "ERP_GATE_TIMEOUT", 5),
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
        raise APIException(
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
    "unmark_delivered": (),
    "cancel_shipment": (),
    "record_delivery_outcome": ("outcome", "note"),
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

    Returns ``{"message": <ERP's own success message>}``. Raises with the
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
            timeout=getattr(settings, "ERP_GATE_TIMEOUT", 5),
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
        raise APIException(
            _erp_error_message(response),
            code="erp_action_refused",
            status_code=409,
        )

    message = ((response.json() or {}).get("message")) or "Done."
    return {"message": message}


# ---------------------------------------------------------------------------
# ERP feature flags (list / toggle)
# ---------------------------------------------------------------------------

# Whitelisted @frappe.whitelist() module methods — the only feature-flag
# surface the fork exposes. Same doctrine as the shipment actions: the ERP
# owns the flags and their validation; the relay only carries them.
FEATURES_LIST_PATH = "/api/method/karrio_shipping.api.features.list_features"
FEATURES_SET_PATH = "/api/method/karrio_shipping.api.features.set_feature"


def _post_erp_method(path: str, payload: dict, label: str):
    """POST one whitelisted Frappe method and return the unwrapped ``message``.

    Same fail-closed doctrine as the shipment relays: missing configuration
    and an unreachable ERP raise 424, an ERP refusal raises 409 carrying the
    ERP's own message.
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
            timeout=getattr(settings, "ERP_GATE_TIMEOUT", 5),
        )
    except requests.RequestException as error:
        logger.warning("ERP %s unreachable: %s", label, error)
        raise APIException(
            "ERP unreachable — try again in a moment.",
            code="erp_gate_unreachable",
            status_code=424,
        )

    if response.status_code >= 400:
        raise APIException(
            _erp_error_message(response),
            code="erp_action_refused",
            status_code=409,
        )

    return (response.json() or {}).get("message")


def run_erp_features_list() -> dict:
    """Relay the ERP's feature-flag listing; returns ``{"features": [...]}``."""
    message = _post_erp_method(FEATURES_LIST_PATH, {}, "features list")
    features = message.get("features") if isinstance(message, dict) else message
    return {"features": features or []}


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
    return {"key": result.get("key", key), "enabled": result.get("enabled", enabled)}
