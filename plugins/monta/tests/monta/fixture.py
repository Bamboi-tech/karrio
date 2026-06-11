"""Monta carrier tests fixtures."""

import karrio.sdk as karrio


gateway = karrio.gateway["monta"].create(
    dict(
        id="123456789",
        test_mode=True,
        carrier_id="monta",
        username="TEST_USERNAME",
        password="TEST_PASSWORD",
        config=dict(
            origin="bamboi",
            include_return_labels=True,
        ),
    )
)
