from karrio.core.metadata import PluginMetadata

from karrio.mappers.monta.mapper import Mapper
from karrio.mappers.monta.proxy import Proxy
from karrio.mappers.monta.settings import Settings
import karrio.providers.monta.units as units
import karrio.providers.monta.utils as utils


# This METADATA object is used by Karrio to discover and register this plugin
# when loaded through Python entrypoints or local plugin directories.
# The entrypoint is defined in pyproject.toml under [project.entry-points."karrio.plugins"]
METADATA = PluginMetadata(
    id="monta",
    label="Monta",
    description=(
        "Monta fulfillment integration for Karrio: order registration with "
        "address verification, colli, shipping labels and order event tracking."
    ),
    status="beta",
    # Integrations
    Mapper=Mapper,
    Proxy=Proxy,
    Settings=Settings,
    # Data Units
    is_hub=False,
    options=units.ShippingOption,
    services=units.ShippingService,
    connection_configs=units.ConnectionConfig,
    # Extra info
    website="https://www.monta.nl",
    documentation="https://api-v6.monta.nl/index.html",
)
