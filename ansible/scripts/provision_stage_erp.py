"""Idempotent staging-only ERP account provisioning; credentials arrive on stdin."""

import contextlib
import io
import json
import os
import re
import sys

EMAIL = "karrio-erp-staging@bamboi.eu"
PURPOSE = "bamboi-staging-erp"


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
        return {"user_id": user.id, "created": created, "organization_id": None}


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
