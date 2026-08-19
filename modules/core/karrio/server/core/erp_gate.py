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
from django.utils.translation import gettext_lazy as _

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
            _(
                "This shipment is managed by ERP but the ERP label gate is not configured "
                "(ERP_GATE_URL / ERP_GATE_TOKEN) — buy the label via the ERP button instead."
            ),
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
            _(
                "ERP label gate unreachable — the purchase is refused to be safe. "
                "Try again in a moment or buy the label via the ERP button."
            ),
            code="erp_gate_unreachable",
            status_code=424,
        )

    if not result.get("allowed"):
        raise APIException(
            result.get("reason")
            or _("ERP refused the label purchase for this shipment."),
            code="erp_gate_blocked",
            status_code=409,
        )


# ---------------------------------------------------------------------------
# ERP shipment actions (Mark Picked / Undo pick / Mark Out for Delivery)
# ---------------------------------------------------------------------------

# Whitelisted @frappe.whitelist() doc methods on the ERP's Karrio Shipment.
# The relay adds no logic of its own: the ERP enforces its own gates
# (assert_order_not_blocked, assert_self_delivery_allowed) and mirrors the
# resulting erp_status back onto this shipment's metadata by itself.
ERP_SHIPMENT_ACTIONS = {
    "mark_picked",
    "unmark_picked",
    "mark_out_for_delivery",
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
    return _("ERP refused the action.")


def run_erp_shipment_action(shipment, action: str) -> dict:
    """Relay one warehouse action to the ERP's Karrio Shipment document.

    Returns ``{"message": <ERP's own success message>}``. Raises with the
    ERP's refusal (hold, wrong status, wrong mode) or on transport failure —
    same fail-closed doctrine as the label gate.
    """
    if action not in ERP_SHIPMENT_ACTIONS:
        raise APIException(
            _("Unknown ERP shipment action."),
            code="erp_action_unknown",
            status_code=400,
        )

    metadata = getattr(shipment, "metadata", None) or {}
    docname = metadata.get("karrio_shipment")
    if not docname:
        raise APIException(
            _("This shipment is not linked to an ERP shipment."),
            code="erp_action_unlinked",
            status_code=409,
        )

    url = getattr(settings, "ERP_GATE_URL", None)
    token = getattr(settings, "ERP_GATE_TOKEN", None)
    if not url or not token:
        raise APIException(
            _(
                "The ERP link is not configured (ERP_GATE_URL / ERP_GATE_TOKEN) — "
                "run this action from the ERP instead."
            ),
            code="erp_gate_unconfigured",
            status_code=424,
        )

    try:
        response = requests.post(
            url.rstrip("/") + RUN_DOC_METHOD_PATH,
            json={"dt": "Karrio Shipment", "dn": docname, "method": action},
            headers={"Authorization": f"token {token}"},
            timeout=getattr(settings, "ERP_GATE_TIMEOUT", 5),
        )
    except requests.RequestException as error:
        logger.warning(
            "ERP action %s unreachable for %s: %s", action, shipment.id, error
        )
        raise APIException(
            _(
                "ERP unreachable — try again in a moment or run this action from the ERP."
            ),
            code="erp_gate_unreachable",
            status_code=424,
        )

    if response.status_code >= 400:
        raise APIException(
            _erp_error_message(response),
            code="erp_action_refused",
            status_code=409,
        )

    message = ((response.json() or {}).get("message")) or _("Done.")
    return {"message": message}
