import logging

logging.disable(logging.CRITICAL)

from karrio.server.graph.tests.test_templates import *
from karrio.server.graph.tests.test_carrier_connections import *
from karrio.server.graph.tests.test_user_info import *
from karrio.server.graph.tests.test_rate_sheets import *
from karrio.server.graph.tests.test_metafield import *
from karrio.server.graph.tests.test_pickups import *
from karrio.server.graph.tests.test_partial_shipments import *
from karrio.server.graph.tests.test_rate_sheet_bulk_ops import *
from karrio.server.graph.tests.test_registration import *
from karrio.server.graph.tests.test_change_shipment_status import *
from karrio.server.graph.tests.test_warehouse_worklist import *
from karrio.server.graph.tests.test_manifests import *
