"""Label orientation normalization (connection config `portrait_labels`).

PostNL draws its A6 labels in landscape while the label roll is portrait;
rotating at ingest keeps every consumer (dashboard print, ERP attachment,
PrintNode) on an upright label without per-printer driver tricks.
"""

import io
import base64
import unittest

import PyPDF2

import karrio.sdk as karrio
import karrio.providers.monta.utils as provider_utils
import karrio.providers.monta.shipment.create as create

portrait_gateway = karrio.gateway["monta"].create(
    dict(
        id="123456789",
        test_mode=True,
        carrier_id="monta",
        username="TEST_USERNAME",
        password="TEST_PASSWORD",
        config=dict(origin="bamboi", portrait_labels=True),
    )
)


def _pdf(width: float, height: float, rotate: int = 0) -> str:
    writer = PyPDF2.PdfWriter()
    writer.add_blank_page(width=width, height=height)
    buffer = io.BytesIO()
    writer.write(buffer)
    if rotate:
        # PyPDF2 does not serialize rotate() on a page still owned by a
        # writer — the flag survives only on a reader page. Round-trip so the
        # fixture genuinely carries /Rotate instead of silently dropping it
        # (which had this file's prerotated test passing against a plain
        # portrait page).
        reader = PyPDF2.PdfReader(io.BytesIO(buffer.getvalue()))
        rotated = PyPDF2.PdfWriter()
        rotated.add_page(reader.pages[0].rotate(rotate))
        buffer = io.BytesIO()
        rotated.write(buffer)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def _first_page(encoded: str) -> PyPDF2.PageObject:
    return PyPDF2.PdfReader(io.BytesIO(base64.b64decode(encoded))).pages[0]


# A6 in points: 298 x 420.
LANDSCAPE = _pdf(420, 298)
PORTRAIT = _pdf(298, 420)


class TestPortraitizePdf(unittest.TestCase):
    def test_landscape_page_becomes_portrait(self):
        page = _first_page(provider_utils.portraitize_pdf(LANDSCAPE))

        self.assertTrue(page.rotation % 180 == 90)

    def test_portrait_input_passes_through_byte_identical(self):
        self.assertEqual(provider_utils.portraitize_pdf(PORTRAIT), PORTRAIT)

    def test_prerotated_landscape_comes_back_upright(self):
        # Portrait mediabox already flagged /Rotate 90 renders landscape.
        # Clearing the flag restores the authored portrait; adding 90 instead
        # would land on /Rotate 180 — portrait, but printed upside down, which
        # the old % 180 assertion could not tell apart from upright.
        prerotated = _pdf(298, 420, rotate=90)
        self.assertEqual(_first_page(prerotated).rotation % 360, 90)  # fixture sanity

        page = _first_page(provider_utils.portraitize_pdf(prerotated))

        self.assertEqual(page.rotation % 360, 0)

    def test_mixed_document_rotates_only_its_landscape_pages(self):
        # One file, three pages: landscape, portrait, prerotated. Rotation is
        # per page — the portrait page must ride along untouched.
        writer = PyPDF2.PdfWriter()
        for encoded in (LANDSCAPE, PORTRAIT, _pdf(298, 420, rotate=90)):
            writer.add_page(_first_page(encoded))
        buffer = io.BytesIO()
        writer.write(buffer)
        mixed = base64.b64encode(buffer.getvalue()).decode("utf-8")

        pages = PyPDF2.PdfReader(
            io.BytesIO(base64.b64decode(provider_utils.portraitize_pdf(mixed)))
        ).pages

        self.assertEqual([page.rotation % 360 for page in pages], [90, 0, 0])


class TestExtractDetailsPortrait(unittest.TestCase):
    def _response(self, file: str, label_file_type: str = "PDF") -> dict:
        return {
            "webshop_order_id": "SAL-ORD-2026-00001",
            "label_file_type": label_file_type,
            "labels": [
                {
                    "FileName": "label.pdf",
                    "file": file,
                    "Colli": [{"Number": 1, "TrackAndTraceCode": "3SABCD0123456789"}],
                }
            ],
        }

    def test_config_on_rotates_the_stored_label(self):
        details = create._extract_details(
            self._response(LANDSCAPE), portrait_gateway.settings
        )

        self.assertTrue(_first_page(details.docs.label).rotation % 180 == 90)
        self.assertEqual(details.docs.label, details.docs.extra_documents[0].base64)

    def test_config_off_keeps_the_carrier_bytes(self):
        from .fixture import gateway

        details = create._extract_details(self._response(LANDSCAPE), gateway.settings)

        self.assertEqual(details.docs.label, LANDSCAPE)

    def test_unparseable_file_survives_untouched(self):
        broken = base64.b64encode(b"not a pdf").decode("utf-8")
        details = create._extract_details(
            self._response(broken), portrait_gateway.settings
        )

        self.assertEqual(details.docs.label, broken)


if __name__ == "__main__":
    unittest.main()
