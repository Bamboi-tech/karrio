"""Idempotent staging-only ERP account provisioning; credentials arrive on stdin."""

import contextlib
import io
import hashlib
import json
import os
import re
import sys

EMAIL = "karrio-erp-staging@bamboi.eu"
PURPOSE = "bamboi-staging-erp"


def clone_connections(user, sources):
    from karrio.server.providers.models import CarrierConnection

    fields = (
        "carrier_code",
        "carrier_id",
        "credentials",
        "config",
        "capabilities",
        "active",
        "test_mode",
        "rate_sheet_id",
        "metadata",
    )
    bindings = dict(user.metadata.get("carrier_sources") or {})
    changed = False
    for expected in sources:
        source = CarrierConnection.objects.select_for_update(of=("self",)).get(
            pk=expected["id"]
        )
        if source.created_by_id != 1 or any(
            getattr(source, key) != expected[key]
            for key in ("carrier_id", "carrier_code", "active", "test_mode")
        ):
            raise ValueError(
                "Staging source connection does not match the reviewed plan."
            )
        values = {key: getattr(source, key) for key in fields}
        digest = hashlib.sha256(
            json.dumps(values, sort_keys=True, default=str).encode()
        ).hexdigest()
        binding = bindings.get(source.pk)
        if binding:
            if binding["digest"] != digest:
                raise ValueError(
                    "Source connection changed; review configuration before resynchronizing."
                )
            clone = CarrierConnection.objects.select_for_update(of=("self",)).get(
                pk=binding["clone_id"]
            )
            if clone.created_by_id != user.id or any(
                getattr(clone, key) != value for key, value in values.items()
            ):
                raise ValueError(
                    "Dedicated connection changed; manual review is required."
                )
        else:
            if CarrierConnection.objects.filter(
                created_by=user, carrier_id=source.carrier_id
            ).exists():
                raise ValueError("Unbound dedicated connection collision.")
            clone = CarrierConnection.objects.create(created_by=user, **values)
            # The create signal expands empty capabilities; keep the reviewed
            # source's explicit representation so repeat checks stay exact.
            if clone.capabilities != values["capabilities"]:
                CarrierConnection.objects.filter(pk=clone.pk).update(
                    capabilities=values["capabilities"]
                )
            bindings[source.pk] = {"clone_id": clone.pk, "digest": digest}
            changed = True
    if changed:
        user.metadata = {**user.metadata, "carrier_sources": bindings}
        user.save(update_fields=["metadata"])
    return changed, len(sources)


def provision(payload):
    import django

    django.setup()
    from django.conf import settings
    from django.db import transaction
    from karrio.server.user.models import User, Token
    import karrio.server.conf as conf

    if (
        payload.get("environment") != "staging"
        or settings.ERP_GATE_URL != "https://stage-erp.bamboi.eu"
    ):
        raise ValueError("Provisioning requires the staging ERP endpoint.")
    if conf.settings.MULTI_ORGANIZATIONS:
        raise ValueError("This staging provisioner requires single-tenant ownership.")
    token = payload.get("token", "")
    if not re.fullmatch(r"key_[a-f0-9]{32}", token):
        raise ValueError("Invalid service token format.")
    with transaction.atomic():
        user = User.objects.select_for_update().filter(email=EMAIL).first()
        created = user is None
        if created:
            user = User.objects.create_user(
                email=EMAIL,
                password=None,
                full_name="Staging ERP integration",
                is_staff=False,
                is_superuser=False,
                is_active=True,
                metadata={"purpose": PURPOSE},
            )
        if (
            user.is_staff
            or user.is_superuser
            or user.has_usable_password()
            or not user.is_active
            or user.metadata.get("purpose") != PURPOSE
        ):
            raise ValueError(
                "Existing account is not the dedicated staging integration."
            )
        existing = Token.objects.filter(key=token).first()
        if existing and (existing.user_id != user.id or existing.test_mode):
            raise ValueError("Token ownership does not match the dedicated account.")
        if user.tokens.exclude(key=token).exists():
            raise ValueError(
                "Existing service credentials differ; explicit rotation is required."
            )
        Token.objects.get_or_create(
            key=token, defaults={"user": user, "test_mode": False, "label": PURPOSE}
        )
        connections_changed, connection_count = clone_connections(
            user, payload.get("source_connections", [])
        )
        return {
            "user_id": user.id,
            "created": created,
            "changed": created or connections_changed,
            "organization_id": None,
            "connection_count": connection_count,
        }


if __name__ == "__main__":
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "karrio.server.settings")
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            result = provision(json.load(sys.stdin))
        print(json.dumps(result))
    except Exception:
        # Never include payloads, credentials, or database errors in remote logs.
        print(
            "Staging ERP provisioning failed; inspect configuration securely.",
            file=sys.stderr,
        )
        sys.exit(1)
