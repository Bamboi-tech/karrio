"""Karrio Monta shipment API implementation.

This is the **packing phase** of the Monta integration. The order itself was
already registered with Monta during rating (see `rate.py`). Purchasing the
shipment label triggers the proxy chain:

1. `GET  /order/{id}/colli`            (idempotency guard)
2. `POST /order/{id}/colli`            (one collo per parcel)
3. `POST /order/{id}/shippinglabels`   (marks the order as shipped in Monta!)
4. `GET  /order/{id}/shippinglabels/{filename}` (label PDF download)
5. `GET  /order/{id}/returnlabels`     (optional return label references)
"""

import karrio.schemas.monta.collo_request as monta

import typing
import karrio.lib as lib
import karrio.core.models as models
import karrio.core.errors as errors
import karrio.providers.monta.error as error
import karrio.providers.monta.utils as provider_utils
import karrio.providers.monta.units as provider_units


def parse_shipment_response(
    _response: lib.Deserializable[dict],
    settings: provider_utils.Settings,
) -> typing.Tuple[models.ShipmentDetails, typing.List[models.Message]]:
    response = _response.deserialize()

    messages = error.parse_error_response(
        [response, *(response.get("errors") or [])], settings
    )
    shipment = (
        _extract_details(response, settings)
        if any(response.get("labels") or [])
        else None
    )

    return shipment, messages


def _extract_details(
    response: dict,
    settings: provider_utils.Settings,
) -> models.ShipmentDetails:
    webshop_order_id = response.get("webshop_order_id")
    labels = response.get("labels") or []
    label_type = response.get("label_file_type") or "PDF"
    colli = [collo for label in labels for collo in (label.get("Colli") or [])] or (
        response.get("colli") or []
    )
    return_labels = response.get("return_labels") or []
    label_files = [label["file"] for label in labels if label.get("file")]

    tracking_numbers = [
        collo["TrackAndTraceCode"] for collo in colli if collo.get("TrackAndTraceCode")
    ]
    tracking_links = [
        collo["TrackAndTraceLink"] for collo in colli if collo.get("TrackAndTraceLink")
    ]
    first_return = next(iter(return_labels), None)

    # Monta prints one label per collo, but whether that arrives as N files or
    # as one file covering N colli depends on the shipper — label_map records
    # which file covers which collo numbers (and where its content sits in
    # docs.extra_documents) so consumers never have to parse filenames. A label
    # whose download failed keeps its map entry without a document_index.
    #
    # Indexing convention: document_index is the 0-based position in the
    # docs.extra_documents list, while the documents themselves are named
    # collo_label_{n} with n starting at 1 — so category == collo_label_{
    # document_index + 1}. Both are exposed so consumers can match by category
    # name (safe) or index the list (0-based) without an off-by-one.
    document_indexes = {
        index: position
        for position, index in enumerate(
            index for index, label in enumerate(labels) if label.get("file")
        )
    }
    label_map = [
        dict(
            file_name=label.get("FileName"),
            colli=[collo.get("Number") for collo in (label.get("Colli") or [])],
            document_index=document_indexes.get(index),
            category=(
                f"collo_label_{document_indexes[index] + 1}"
                if index in document_indexes
                else None
            ),
        )
        for index, label in enumerate(labels)
    ]

    return models.ShipmentDetails(
        carrier_id=settings.carrier_id,
        carrier_name=settings.carrier_name,
        # Karrio polls trackers by this number; the Monta provider tracks per
        # order, so the WebshopOrderId *is* the tracking number. The carrier
        # level track & trace codes are exposed in meta.tracking_numbers.
        tracking_number=webshop_order_id,
        shipment_identifier=webshop_order_id,
        label_type=label_type,
        docs=models.Documents(
            # The bundled label is the compatibility surface (label_url,
            # dashboard, ERP fallback); the per-collo files travel unbundled in
            # extra_documents so each box can get its own printed label.
            label=(
                label_files[0]
                if len(label_files) == 1
                else lib.bundle_base64(label_files, label_type)
            ),
            extra_documents=[
                models.ShippingDocument(
                    category=f"collo_label_{position}",
                    format=label_type,
                    base64=file,
                )
                for position, file in enumerate(label_files, start=1)
            ],
        ),
        return_shipment=(
            models.ReturnShipment(
                tracking_number=first_return.get("TrackAndTraceCode"),
                tracking_url=first_return.get("TrackAndTraceLink"),
                service=first_return.get("ShipperDescription"),
            )
            if first_return
            else None
        ),
        meta=dict(
            webshop_order_id=webshop_order_id,
            shipment_identifiers=[webshop_order_id],
            tracking_numbers=tracking_numbers or [webshop_order_id],
            tracking_links=tracking_links,
            carrier_tracking_link=next(iter(tracking_links), None),
            colli=colli,
            label_files=[label.get("FileName") for label in labels],
            label_map=label_map,
            return_labels=return_labels,
        ),
    )


def shipment_request(
    payload: models.ShipmentRequest,
    settings: provider_utils.Settings,
) -> lib.Serializable:
    packages = lib.to_packages(payload.parcels)
    options = lib.to_shipping_options(
        payload.options,
        package_options=packages.options,
        initializer=provider_units.shipping_options_initializer,
    )

    webshop_order_id = options.monta_webshop_order_id.state or payload.reference

    if not webshop_order_id:
        raise errors.ShippingSDKError(
            "A 'reference' (or 'monta_webshop_order_id' option) is required: "
            "Monta orders are keyed by the client supplied WebshopOrderId."
        )

    # Monta weighs every collo itself at the warehouse (their words), while a
    # declared weight actively hurts: their product auto-selection rejects e.g.
    # a >2 kg collo on a Buspakje product. When the connection (or a shipment
    # option) says so, declare no weight at all and let Monta measure.
    omit_weight = (
        options.monta_omit_collo_weight.state
        if options.monta_omit_collo_weight.state is not None
        else settings.connection_config.omit_collo_weight.state
    )

    colli = [
        monta.ColloRequestType(
            Number=index,
            WeightGrammes=(
                None
                if omit_weight
                else lib.to_int((package.weight.KG or 0) * 1000) or None
            ),
            LengthMm=lib.to_int((package.length.CM or 0) * 10) or None,
            WidthMm=lib.to_int((package.width.CM or 0) * 10) or None,
            HeightMm=lib.to_int((package.height.CM or 0) * 10) or None,
            PackageDescription=(
                package.parcel.description or f"Box {index} of {len(packages)}"
            ),
        )
        for index, package in enumerate(packages, start=1)
    ]

    include_return_labels = (
        options.monta_include_return_labels.state
        if options.monta_include_return_labels.state is not None
        else settings.connection_config.include_return_labels.state
    )

    return lib.Serializable(
        dict(
            webshop_order_id=webshop_order_id,
            colli=lib.to_dict(colli),
            include_return_labels=include_return_labels,
            label_file_type=(
                payload.label_type
                or settings.connection_config.label_file_type.state
                or "PDF"
            ),
        ),
        lib.to_dict,
    )
