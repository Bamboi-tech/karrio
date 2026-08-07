"""Monta carrier shipment (colli + labels) tests."""

import base64
import unittest
from unittest.mock import patch
from .fixture import gateway

import karrio.sdk as karrio
import karrio.lib as lib
import karrio.core.models as models


class TestMontaShipment(unittest.TestCase):
    def setUp(self):
        self.maxDiff = None
        self.ShipmentRequest = models.ShipmentRequest(**ShipmentPayload)
        self.TwoParcelShipmentRequest = models.ShipmentRequest(**TwoParcelPayload)
        self.ShipmentCancelRequest = models.ShipmentCancelRequest(
            **ShipmentCancelPayload
        )

    def test_create_shipment_request(self):
        request = gateway.mapper.create_shipment_request(self.ShipmentRequest)

        self.assertEqual(request.serialize(), ShipmentRequest)

    def test_create_two_parcel_shipment_request(self):
        request = gateway.mapper.create_shipment_request(self.TwoParcelShipmentRequest)

        self.assertEqual(request.serialize(), TwoParcelShipmentRequest)

    def test_create_shipment_calls_the_packing_chain(self):
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = [
                "[]",  # GET colli (idempotency guard)
                ColloResponse,  # POST colli
                ShippingLabelsResponse,  # POST shippinglabels
                LabelFileContent,  # GET shippinglabels/{filename}
                ReturnLabelsResponse,  # GET returnlabels
            ]
            karrio.Shipment.create(self.ShipmentRequest).from_(gateway)

            urls = [call[1]["url"] for call in mock.call_args_list]
            methods = [call[1]["method"] for call in mock.call_args_list]
            base = f"{gateway.settings.server_url}/order/SAL-ORD-2026-00001"

            self.assertEqual(
                urls,
                [
                    f"{base}/colli",
                    f"{base}/colli",
                    # lowercase on the wire — Monta rejects "PDF"
                    f"{base}/shippinglabels?labelfiletype=pdf",
                    f"{base}/shippinglabels/SAL-ORD-2026-00001_DHL_1.pdf",
                    f"{base}/returnlabels",
                ],
            )
            self.assertEqual(methods, ["GET", "POST", "POST", "GET", "GET"])

    def test_create_shipment_skips_existing_colli(self):
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = [
                ExistingColliResponse,  # GET colli -> collo 1 already registered
                ShippingLabelsResponse,  # POST shippinglabels
                LabelFileContent,  # GET shippinglabels/{filename}
                ReturnLabelsResponse,  # GET returnlabels
            ]
            karrio.Shipment.create(self.ShipmentRequest).from_(gateway)

            self.assertEqual(mock.call_count, 4)

    def test_create_shipment_labels_an_order_without_boxes_yet(self):
        """Monta rejects the guard GET until the first collo exists. That is the
        starting state of every order and must not suppress the label call."""
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = [
                NoShippingBoxesResponse,  # GET colli -> 404 "no shipping boxes"
                ColloResponse,  # POST colli
                ShippingLabelsResponse,  # POST shippinglabels
                LabelFileContent,
                ReturnLabelsResponse,
            ]
            parsed_response = (
                karrio.Shipment.create(self.ShipmentRequest).from_(gateway).parse()
            )

            methods = [call[1]["method"] for call in mock.call_args_list]
            self.assertEqual(methods, ["GET", "POST", "POST", "GET", "GET"])
            self.assertListEqual(lib.to_dict(parsed_response), ParsedShipmentResponse)

    def test_create_shipment_skips_colli_reported_as_shipped_boxes(self):
        """The guard GET answers in the shipped-boxes shape, not the shape POST
        returns. Missing that re-posts every collo Monta already has."""
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = [
                ShippedBoxesResponse,  # GET colli -> collo 1 already registered
                ShippingLabelsResponse,  # POST shippinglabels
                LabelFileContent,
                ReturnLabelsResponse,
            ]
            karrio.Shipment.create(self.ShipmentRequest).from_(gateway)

            methods = [call[1]["method"] for call in mock.call_args_list]
            self.assertEqual(methods, ["GET", "POST", "GET", "GET"])

    def test_create_shipment_treats_duplicate_collo_as_registered(self):
        """Code 39 means the collo is on the order — the outcome this step
        wants. It must not block the label."""
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = [
                NoShippingBoxesResponse,  # GET colli
                DuplicateColloResponse,  # POST colli -> Code 39
                ShippingLabelsResponse,  # POST shippinglabels
                LabelFileContent,
                ReturnLabelsResponse,
            ]
            parsed_response = (
                karrio.Shipment.create(self.ShipmentRequest).from_(gateway).parse()
            )

            methods = [call[1]["method"] for call in mock.call_args_list]
            self.assertEqual(methods, ["GET", "POST", "POST", "GET", "GET"])
            self.assertEqual(lib.to_dict(parsed_response)[1], [])

    def test_parse_shipment_response(self):
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = [
                "[]",
                ColloResponse,
                ShippingLabelsResponse,
                LabelFileContent,
                ReturnLabelsResponse,
            ]
            parsed_response = (
                karrio.Shipment.create(self.ShipmentRequest).from_(gateway).parse()
            )

            self.assertListEqual(lib.to_dict(parsed_response), ParsedShipmentResponse)

    def test_parse_two_parcel_shipment_with_one_label_file_per_collo(self):
        """Response shape (a): Monta answers with one label object per collo,
        each carrying its own file. Every file must surface unbundled in
        extra_documents, and label_map must pair file <-> collo <-> document."""
        request = models.ShipmentRequest(**{**TwoParcelPayload, "label_type": "ZPL"})

        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = [
                "[]",  # GET colli
                ColloResponse,  # POST colli (1)
                SecondColloResponse,  # POST colli (2)
                TwoLabelObjectsResponse,  # POST shippinglabels
                LabelZpl1,  # GET shippinglabels/{filename 1}
                LabelZpl2,  # GET shippinglabels/{filename 2}
                ReturnLabelsResponse,  # GET returnlabels
            ]
            parsed_response = karrio.Shipment.create(request).from_(gateway).parse()

            urls = [call[1]["url"] for call in mock.call_args_list]
            base = f"{gateway.settings.server_url}/order/SAL-ORD-2026-00001"
            self.assertIn(f"{base}/shippinglabels/SAL-ORD-2026-00001_DHL_1.zpl", urls)
            self.assertIn(f"{base}/shippinglabels/SAL-ORD-2026-00001_DHL_2.zpl", urls)
            self.assertListEqual(
                lib.to_dict(parsed_response), ParsedTwoLabelFilesResponse
            )

    def test_parse_two_parcel_shipment_with_one_file_covering_both_colli(self):
        """Response shape (b): Monta answers with a single label object whose
        Colli array covers both boxes (one file, N pages). One document, one
        label_map entry listing both collo numbers."""
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = [
                "[]",  # GET colli
                ColloResponse,  # POST colli (1)
                SecondColloResponse,  # POST colli (2)
                SingleLabelTwoColliResponse,  # POST shippinglabels
                LabelFileContent,  # GET shippinglabels/{filename}
                ReturnLabelsResponse,  # GET returnlabels
            ]
            parsed_response = (
                karrio.Shipment.create(self.TwoParcelShipmentRequest)
                .from_(gateway)
                .parse()
            )

            methods = [call[1]["method"] for call in mock.call_args_list]
            self.assertEqual(methods, ["GET", "POST", "POST", "POST", "GET", "GET"])
            self.assertListEqual(
                lib.to_dict(parsed_response), ParsedSingleFileTwoColliResponse
            )

    def test_create_shipment_surfaces_failed_label_download(self):
        """A failed label download must land in the messages — silently
        shipping a box without its label is the one outcome this flow may
        never produce — while the remaining labels still come through."""
        request = models.ShipmentRequest(**{**TwoParcelPayload, "label_type": "ZPL"})
        chain = iter(
            [
                "[]",  # GET colli
                ColloResponse,  # POST colli (1)
                SecondColloResponse,  # POST colli (2)
                TwoLabelObjectsResponse,  # POST shippinglabels
                ReturnLabelsResponse,  # GET returnlabels
            ]
        )
        downloads = iter([DOWNLOAD_FAILURE, LabelZpl2])

        def answer(**kwargs):
            if kwargs["method"] == "GET" and "/shippinglabels/" in kwargs["url"]:
                download = next(downloads)
                if download is DOWNLOAD_FAILURE:
                    return kwargs["on_error"](FakeHTTPError())
                return download
            return next(chain)

        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = answer
            parsed_response = karrio.Shipment.create(request).from_(gateway).parse()

            self.assertListEqual(
                lib.to_dict(parsed_response), ParsedFailedDownloadResponse
            )

    def test_parse_shipment_error_response(self):
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.side_effect = [
                "[]",
                InvalidOrderResponse,  # POST colli rejected
            ]
            parsed_response = (
                karrio.Shipment.create(self.ShipmentRequest).from_(gateway).parse()
            )

            self.assertListEqual(lib.to_dict(parsed_response), ParsedErrorResponse)

    def test_cancel_shipment(self):
        with patch("karrio.mappers.monta.proxy.lib.request") as mock:
            mock.return_value = ""
            parsed_response = (
                karrio.Shipment.cancel(self.ShipmentCancelRequest)
                .from_(gateway)
                .parse()
            )

            self.assertEqual(
                mock.call_args[1]["url"],
                f"{gateway.settings.server_url}/order/SAL-ORD-2026-00001",
            )
            self.assertEqual(mock.call_args[1]["method"], "DELETE")
            self.assertListEqual(lib.to_dict(parsed_response), ParsedCancelResponse)


if __name__ == "__main__":
    unittest.main()


ShipmentPayload = {
    "reference": "SAL-ORD-2026-00001",
    "service": "monta_fulfillment",
    "shipper": {
        "company_name": "Bamboi",
        "address_line1": "Warehouseweg 1",
        "postal_code": "1000 AA",
        "city": "Amsterdam",
        "country_code": "NL",
    },
    "recipient": {
        "person_name": "Jan van Dijk",
        "address_line1": "Keizersgracht 75 A",
        "postal_code": "1015 CE",
        "city": "Amsterdam",
        "country_code": "NL",
    },
    "parcels": [
        {
            "weight": 1.5,
            "weight_unit": "KG",
            "length": 40.0,
            "width": 30.0,
            "height": 20.0,
            "dimension_unit": "CM",
        }
    ],
}

TwoParcelPayload = {
    **ShipmentPayload,
    "parcels": [
        {
            "weight": 1.5,
            "weight_unit": "KG",
            "length": 40.0,
            "width": 30.0,
            "height": 20.0,
            "dimension_unit": "CM",
        },
        {
            "weight": 1.5,
            "weight_unit": "KG",
            "length": 40.0,
            "width": 30.0,
            "height": 20.0,
            "dimension_unit": "CM",
        },
    ],
}

ShipmentCancelPayload = {
    "shipment_identifier": "SAL-ORD-2026-00001",
}

ShipmentRequest = {
    "webshop_order_id": "SAL-ORD-2026-00001",
    "colli": [
        {
            "Number": 1,
            "WeightGrammes": 1500,
            "LengthMm": 400,
            "WidthMm": 300,
            "HeightMm": 200,
            "PackageDescription": "Box 1 of 1",
        }
    ],
    "include_return_labels": True,
    "label_file_type": "PDF",
}

TwoParcelShipmentRequest = {
    "webshop_order_id": "SAL-ORD-2026-00001",
    "colli": [
        {
            "Number": 1,
            "WeightGrammes": 1500,
            "LengthMm": 400,
            "WidthMm": 300,
            "HeightMm": 200,
            "PackageDescription": "Box 1 of 2",
        },
        {
            "Number": 2,
            "WeightGrammes": 1500,
            "LengthMm": 400,
            "WidthMm": 300,
            "HeightMm": 200,
            "PackageDescription": "Box 2 of 2",
        },
    ],
    "include_return_labels": True,
    "label_file_type": "PDF",
}

ColloResponse = """{
    "Number": 1,
    "WeightGrammes": 1500,
    "LengthMm": 400,
    "WidthMm": 300,
    "HeightMm": 200,
    "PackageDescription": "Box 1 of 1"
}
"""

SecondColloResponse = """{
    "Number": 2,
    "WeightGrammes": 1500,
    "LengthMm": 400,
    "WidthMm": 300,
    "HeightMm": 200,
    "PackageDescription": "Box 2 of 2"
}
"""

ExistingColliResponse = """[
    {
        "Number": 1,
        "WeightGrammes": 1500,
        "LengthMm": 400,
        "WidthMm": 300,
        "HeightMm": 200,
        "PackageDescription": "Box 1 of 1"
    }
]
"""

# What `error_decoder` makes of Monta's answer to the guard GET while the order
# carries no colli: HTTP 404 with the bare string body "Order has no shipping
# boxes." (observed on production, 6 Aug 2026).
NoShippingBoxesResponse = """{
    "HttpStatus": 404,
    "Message": "Order has no shipping boxes."
}
"""

# The same GET once a collo is registered — a shipped-boxes summary, not the
# ColloResponse list that POST returns (observed on production, 6 Aug 2026).
ShippedBoxesResponse = """{
    "TotalWeightInKg": 1,
    "PalletsShipped": 0,
    "BoxesShipped": 1,
    "ShippedPallets": {},
    "ShippedBoxesOnPallets": [],
    "ShippedBoxesNotOnPallets": [
        {
            "DistinctProducts": 0,
            "TotalProducts": 0,
            "ShippedCarrierInfo": {
                "TTColloNr": 1,
                "PackageDescription": "Collo 1 met verpakking 'Eigen verpakking product'",
                "WeightInGrams": 1000,
                "LengthInMM": 1,
                "WidthInMM": 1,
                "HeightInMM": 1,
                "IsProductItsOwnPackage": true,
                "FitsThroughDutchMailBox": "True",
                "TTCode": "",
                "TTLink": "",
                "DeliveryStatusDescription": "",
                "DeliveryStatusCode": "",
                "DeliveryStatusUpdatedAt": ""
            },
            "ShippedProduct": []
        }
    ]
}
"""

DuplicateColloResponse = """{
    "OrderInvalidReasons": [
        {"Code": 39, "Message": "Collo with given number already exists."}
    ]
}
"""

ShippingLabelsResponse = """[
    {
        "FileName": "SAL-ORD-2026-00001_DHL_1.pdf",
        "Colli": [
            {
                "Number": 1,
                "WeightGrammes": 1500,
                "TrackAndTraceCode": "3SABCD0123456789",
                "TrackAndTraceLink": "https://tracking.example.com/3SABCD0123456789",
                "DeliveryStatusDescription": "Shipped",
                "DeliveryStatusCode": "SHIPPED",
                "DeliveryStatusUpdated": "2026-06-10T15:00:00Z"
            }
        ]
    }
]
"""

LabelFileContent = "JVBERi0xLjQgZmFrZSBwZGY="

# Response shape (a): one label object per collo, each with its own file.
TwoLabelObjectsResponse = """[
    {
        "FileName": "SAL-ORD-2026-00001_DHL_1.zpl",
        "Colli": [
            {
                "Number": 1,
                "TrackAndTraceCode": "3SABCD0000000001",
                "TrackAndTraceLink": "https://tracking.example.com/3SABCD0000000001"
            }
        ]
    },
    {
        "FileName": "SAL-ORD-2026-00001_DHL_2.zpl",
        "Colli": [
            {
                "Number": 2,
                "TrackAndTraceCode": "3SABCD0000000002",
                "TrackAndTraceLink": "https://tracking.example.com/3SABCD0000000002"
            }
        ]
    }
]
"""

# Response shape (b): a single label object (one file, N pages) covering both
# colli in its Colli array.
SingleLabelTwoColliResponse = """[
    {
        "FileName": "SAL-ORD-2026-00001_DHL_1.pdf",
        "Colli": [
            {
                "Number": 1,
                "TrackAndTraceCode": "3SABCD0000000001",
                "TrackAndTraceLink": "https://tracking.example.com/3SABCD0000000001"
            },
            {
                "Number": 2,
                "TrackAndTraceCode": "3SABCD0000000002",
                "TrackAndTraceLink": "https://tracking.example.com/3SABCD0000000002"
            }
        ]
    }
]
"""

# ZPL keeps the multi-file bundling testable: bundle_base64 concatenates ZPL
# as text, while PDF bundling would demand real (parseable) PDF fixtures.
LabelZpl1 = base64.b64encode(b"^XA COLLO 1 ^XZ").decode("utf-8")
LabelZpl2 = base64.b64encode(b"^XA COLLO 2 ^XZ").decode("utf-8")
BundledZplLabel = lib.bundle_base64([LabelZpl1, LabelZpl2], "ZPL")

DOWNLOAD_FAILURE = object()


class FakeHTTPError:
    """The bits of urllib.error.HTTPError that utils.error_decoder reads."""

    code = 500
    reason = "Internal Server Error"

    def read(self):
        return b"boom"


ReturnLabelsResponse = """[
    {
        "ShipperDescription": "PostNL",
        "TrackAndTraceCode": "3SRETURN0123456789",
        "TrackAndTraceLink": "https://tracking.example.com/3SRETURN0123456789",
        "Created": "2026-06-10T15:05:00Z"
    }
]
"""

InvalidOrderResponse = """{
    "OrderInvalidReasons": [
        {"Code": 21, "Message": "Order is already shipped"}
    ]
}
"""

ParsedShipmentResponse = [
    {
        "carrier_id": "monta",
        "carrier_name": "monta",
        "tracking_number": "SAL-ORD-2026-00001",
        "shipment_identifier": "SAL-ORD-2026-00001",
        "label_type": "PDF",
        "docs": {
            "label": "JVBERi0xLjQgZmFrZSBwZGY=",
            "extra_documents": [
                {
                    "category": "collo_label_1",
                    "format": "PDF",
                    "base64": "JVBERi0xLjQgZmFrZSBwZGY=",
                }
            ],
        },
        "return_shipment": {
            "tracking_number": "3SRETURN0123456789",
            "tracking_url": "https://tracking.example.com/3SRETURN0123456789",
            "service": "PostNL",
        },
        "meta": {
            "webshop_order_id": "SAL-ORD-2026-00001",
            "shipment_identifiers": ["SAL-ORD-2026-00001"],
            "tracking_numbers": ["3SABCD0123456789"],
            "tracking_links": ["https://tracking.example.com/3SABCD0123456789"],
            "carrier_tracking_link": "https://tracking.example.com/3SABCD0123456789",
            "colli": [
                {
                    "Number": 1,
                    "WeightGrammes": 1500,
                    "TrackAndTraceCode": "3SABCD0123456789",
                    "TrackAndTraceLink": "https://tracking.example.com/3SABCD0123456789",
                    "DeliveryStatusDescription": "Shipped",
                    "DeliveryStatusCode": "SHIPPED",
                    "DeliveryStatusUpdated": "2026-06-10T15:00:00Z",
                }
            ],
            "label_files": ["SAL-ORD-2026-00001_DHL_1.pdf"],
            "label_map": [
                {
                    "file_name": "SAL-ORD-2026-00001_DHL_1.pdf",
                    "colli": [1],
                    "document_index": 0,
                }
            ],
            "return_labels": [
                {
                    "ShipperDescription": "PostNL",
                    "TrackAndTraceCode": "3SRETURN0123456789",
                    "TrackAndTraceLink": "https://tracking.example.com/3SRETURN0123456789",
                    "Created": "2026-06-10T15:05:00Z",
                }
            ],
        },
    },
    [],
]

_ReturnShipment = {
    "tracking_number": "3SRETURN0123456789",
    "tracking_url": "https://tracking.example.com/3SRETURN0123456789",
    "service": "PostNL",
}

_ReturnLabels = [
    {
        "ShipperDescription": "PostNL",
        "TrackAndTraceCode": "3SRETURN0123456789",
        "TrackAndTraceLink": "https://tracking.example.com/3SRETURN0123456789",
        "Created": "2026-06-10T15:05:00Z",
    }
]

_TwoColli = [
    {
        "Number": 1,
        "TrackAndTraceCode": "3SABCD0000000001",
        "TrackAndTraceLink": "https://tracking.example.com/3SABCD0000000001",
    },
    {
        "Number": 2,
        "TrackAndTraceCode": "3SABCD0000000002",
        "TrackAndTraceLink": "https://tracking.example.com/3SABCD0000000002",
    },
]

_TwoParcelMeta = {
    "webshop_order_id": "SAL-ORD-2026-00001",
    "shipment_identifiers": ["SAL-ORD-2026-00001"],
    "tracking_numbers": ["3SABCD0000000001", "3SABCD0000000002"],
    "tracking_links": [
        "https://tracking.example.com/3SABCD0000000001",
        "https://tracking.example.com/3SABCD0000000002",
    ],
    "carrier_tracking_link": "https://tracking.example.com/3SABCD0000000001",
    "colli": _TwoColli,
    "return_labels": _ReturnLabels,
}

ParsedTwoLabelFilesResponse = [
    {
        "carrier_id": "monta",
        "carrier_name": "monta",
        "tracking_number": "SAL-ORD-2026-00001",
        "shipment_identifier": "SAL-ORD-2026-00001",
        "label_type": "ZPL",
        "docs": {
            "label": BundledZplLabel,
            "extra_documents": [
                {"category": "collo_label_1", "format": "ZPL", "base64": LabelZpl1},
                {"category": "collo_label_2", "format": "ZPL", "base64": LabelZpl2},
            ],
        },
        "return_shipment": _ReturnShipment,
        "meta": {
            **_TwoParcelMeta,
            "label_files": [
                "SAL-ORD-2026-00001_DHL_1.zpl",
                "SAL-ORD-2026-00001_DHL_2.zpl",
            ],
            "label_map": [
                {
                    "file_name": "SAL-ORD-2026-00001_DHL_1.zpl",
                    "colli": [1],
                    "document_index": 0,
                },
                {
                    "file_name": "SAL-ORD-2026-00001_DHL_2.zpl",
                    "colli": [2],
                    "document_index": 1,
                },
            ],
        },
    },
    [],
]

ParsedSingleFileTwoColliResponse = [
    {
        "carrier_id": "monta",
        "carrier_name": "monta",
        "tracking_number": "SAL-ORD-2026-00001",
        "shipment_identifier": "SAL-ORD-2026-00001",
        "label_type": "PDF",
        "docs": {
            "label": LabelFileContent,
            "extra_documents": [
                {
                    "category": "collo_label_1",
                    "format": "PDF",
                    "base64": LabelFileContent,
                }
            ],
        },
        "return_shipment": _ReturnShipment,
        "meta": {
            **_TwoParcelMeta,
            "label_files": ["SAL-ORD-2026-00001_DHL_1.pdf"],
            "label_map": [
                {
                    "file_name": "SAL-ORD-2026-00001_DHL_1.pdf",
                    "colli": [1, 2],
                    "document_index": 0,
                }
            ],
        },
    },
    [],
]

ParsedFailedDownloadResponse = [
    {
        "carrier_id": "monta",
        "carrier_name": "monta",
        "tracking_number": "SAL-ORD-2026-00001",
        "shipment_identifier": "SAL-ORD-2026-00001",
        "label_type": "ZPL",
        "docs": {
            # Only the surviving file — a single label is never bundled.
            "label": LabelZpl2,
            "extra_documents": [
                {"category": "collo_label_1", "format": "ZPL", "base64": LabelZpl2}
            ],
        },
        "return_shipment": _ReturnShipment,
        "meta": {
            **_TwoParcelMeta,
            "label_files": [
                "SAL-ORD-2026-00001_DHL_1.zpl",
                "SAL-ORD-2026-00001_DHL_2.zpl",
            ],
            "label_map": [
                # The failed file keeps its map entry but points at no document.
                {"file_name": "SAL-ORD-2026-00001_DHL_1.zpl", "colli": [1]},
                {
                    "file_name": "SAL-ORD-2026-00001_DHL_2.zpl",
                    "colli": [2],
                    "document_index": 0,
                },
            ],
        },
    },
    [
        {
            "carrier_id": "monta",
            "carrier_name": "monta",
            "code": "500",
            "message": "Label file 'SAL-ORD-2026-00001_DHL_1.zpl' download failed: boom",
            "details": {},
        }
    ],
]

ParsedErrorResponse = [
    None,
    [
        {
            "carrier_id": "monta",
            "carrier_name": "monta",
            "code": "21",
            "message": "Order is already shipped",
            "details": {},
        }
    ],
]

ParsedCancelResponse = [
    {
        "carrier_id": "monta",
        "carrier_name": "monta",
        "operation": "Cancel Shipment",
        "success": True,
    },
    [],
]
