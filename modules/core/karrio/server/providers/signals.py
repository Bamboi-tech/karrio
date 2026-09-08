from django.db.models import signals

import karrio.references as ref
import karrio.server.core.utils as utils
import karrio.server.core.dataunits as dataunits
from karrio.server.core.logging import logger
import karrio.server.providers.models as models

REFERENCE_SOURCES = (
    models.CarrierConnection,
    models.SystemConnection,
    models.BrokeredConnection,
)


def register_signals():
    signals.post_save.connect(carrier_changed, sender=models.CarrierConnection)

    for model in REFERENCE_SOURCES:
        signals.post_save.connect(references_changed, sender=model)
        signals.post_delete.connect(references_changed, sender=model)

    logger.info("Karrio providers signals registered")


def references_changed(sender, **_kwargs):
    """Any connection change invalidates the cached /v1/references payload."""
    dataunits.bump_references_version()


@utils.disable_for_loaddata
def carrier_changed(
    sender, instance, created, raw, using, update_fields, *args, **kwargs
):
    """Setup default capabilities when carrier are created."""
    if not created:
        return

    if len(instance.capabilities or []) == 0:
        instance.capabilities = ref.get_carrier_capabilities(instance.carrier_code)
        instance.save()
