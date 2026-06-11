"""Karrio Monta client settings."""

import attr
import karrio.providers.monta.utils as provider_utils


@attr.s(auto_attribs=True)
class Settings(provider_utils.Settings):
    """Monta connection settings."""

    # Monta REST API v6 HTTP Basic auth credentials
    username: str
    password: str

    # generic properties
    id: str = None
    test_mode: bool = False
    carrier_id: str = "monta"
    account_country_code: str = "NL"
    metadata: dict = {}
    config: dict = {}
