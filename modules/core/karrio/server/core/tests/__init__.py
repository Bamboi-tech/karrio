# Backward-compatible exports for karrio.server.core.tests
# This allows existing imports like:
#   from karrio.server.core.tests import APITestCase
# to continue working

import logging

logging.disable(logging.CRITICAL)

# Import test classes explicitly to enable Django's test discovery
from karrio.server.core.tests.test_exception_level import (
    TestGetDefaultLevel,
    TestAPIException,
    TestIndexedAPIException,
    TestErrorLevelDefaults,
    TestErrorDatatype,
)
from karrio.server.core.tests.test_resource_token import (
    TestResourceAccessTokenUnit,
    TestResourceTokenAPI,
    TestDocumentDownloadWithAPIToken,
)
from karrio.server.core.tests.test_request_id import (
    TestRequestIDValidation,
    TestRequestIDMiddleware,
    TestRequestIDInAPI,
    TestRequestIDPropagation,
)
from karrio.server.core.tests.test_constance_batch import (
    TestBatchFetchConstance,
    TestUpdateSettings,
)
from karrio.server.core.tests.test_erp_gate import (
    TestLabelGate,
    TestShipmentActionRelay,
    TestFeaturesRelay,
    TestRefusalDetailIsSerializable,
)
from karrio.server.core.tests.test_jwt_refresh import (
    TestTokenRefresh,
)
from karrio.server.core.tests.test_references_i18n import (
    TestReferencesTranslation,
    TestCarriersTranslation,
)
from karrio.server.core.tests.test_schema_safety import (
    TestRollingDeploySafetyCheck,
)
from karrio.server.core.tests.test_sentry_noise import (
    TestSentryNoise,
)
from karrio.server.core.tests.test_sentry_shipment_context import (
    TestPropagateToSentry,
)
from karrio.server.core.tests.test_shipment_documents import (
    TestShipmentDocumentsAccessor,
)

# Import our custom APITestCase (must be last to avoid being overridden)
from karrio.server.core.tests.base import APITestCase

__all__ = ["APITestCase"]
