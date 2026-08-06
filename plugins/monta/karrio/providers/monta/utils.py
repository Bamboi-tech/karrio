import re
import base64
import typing
import karrio.lib as lib
import karrio.core as core


class Settings(core.Settings):
    """Monta connection settings."""

    username: str
    password: str

    @property
    def carrier_name(self):
        return "monta"

    @property
    def server_url(self):
        # Monta exposes a single production host. There is no separate sandbox
        # server; Monta provides dedicated test webshop credentials instead, so
        # `test_mode` only tags Karrio-side records.
        return "https://api-v6.monta.nl"

    @property
    def authorization(self):
        pair = "%s:%s" % (self.username, self.password)
        return base64.b64encode(pair.encode("utf-8")).decode("ascii")

    @property
    def connection_config(self) -> lib.units.Options:
        from karrio.providers.monta.units import ConnectionConfig

        return lib.to_connection_config(
            self.config or {},
            option_type=ConnectionConfig,
        )


def error_decoder(error) -> str:
    """Embed the HTTP status code into error response bodies.

    Monta returns plain strings for 404s and JSON objects
    (OrderInvalidReasonsResponse or ProblemDetails) for other errors.
    The proxy needs the status code to drive the PUT -> POST order upsert.
    """
    body = lib.failsafe(lambda: lib.decode(error.read())) or ""
    data = lib.failsafe(lambda: lib.to_dict(body))
    content = (
        data
        if isinstance(data, dict)
        else {"Message": (body.strip().strip('"') or getattr(error, "reason", ""))}
    )

    return lib.to_json({"HttpStatus": error.code, **content})


def request_failed(response: typing.Any) -> bool:
    """True when a decoded Monta body carries an error instead of data."""
    return isinstance(response, dict) and bool(
        response.get("HttpStatus") or response.get("OrderInvalidReasons")
    )


def collo_already_exists(response: typing.Any) -> bool:
    """True when Monta rejects a collo POST because that number is registered.

    Code 39 is the idempotent outcome of the packing step, not a failure: the
    collo the caller wanted is on the order. Treating it as an error strands
    the order packed but unlabeled, because the label call runs only when no
    step before it failed.
    """
    if not isinstance(response, dict):
        return False

    return any(
        str(reason.get("Code")) == "39"
        or "already exists" in (reason.get("Message") or "").lower()
        for reason in response.get("OrderInvalidReasons") or []
    )


def normalize_colli(response: typing.Any) -> typing.List[dict]:
    """Bring Monta's three collo shapes onto the one `ColloResponse` describes.

    `POST /order/{id}/colli` answers with ColloResponse objects, but the
    matching GET answers with a shipped-boxes summary that states the same
    facts under different names (`TTColloNr`, `TTCode`, `WeightInGrams`) — and,
    while the order carries no boxes at all, with the bare string "Order has no
    shipping boxes.". Callers should not have to know which of the three they
    hold; anything unrecognized means no colli are registered.
    """
    if isinstance(response, list):
        return [collo for collo in response if isinstance(collo, dict)]

    if not isinstance(response, dict):
        return []

    boxes = [
        *(response.get("ShippedBoxesNotOnPallets") or []),
        *(response.get("ShippedBoxesOnPallets") or []),
    ]
    carrier_infos = [
        box.get("ShippedCarrierInfo") or {} for box in boxes if isinstance(box, dict)
    ]

    return [
        {
            "Number": info.get("TTColloNr"),
            "WeightGrammes": info.get("WeightInGrams"),
            "LengthMm": info.get("LengthInMM"),
            "WidthMm": info.get("WidthInMM"),
            "HeightMm": info.get("HeightInMM"),
            "PackageDescription": info.get("PackageDescription"),
            "TrackAndTraceCode": info.get("TTCode") or None,
            "TrackAndTraceLink": info.get("TTLink") or None,
            "DeliveryStatusDescription": info.get("DeliveryStatusDescription") or None,
            "DeliveryStatusCode": info.get("DeliveryStatusCode") or None,
            "DeliveryStatusUpdated": info.get("DeliveryStatusUpdatedAt") or None,
        }
        for info in carrier_infos
        if info.get("TTColloNr") is not None
    ]


def parse_house_number(address: lib.units.ComputedAddress) -> typing.Tuple[str, str, str]:
    """Split an address line into (street, house number, addition) as Monta expects.

    Prefers the explicit `street_number` when provided; otherwise extracts the
    trailing number (Dutch convention: "Keizersgracht 75 A") from address_line1.
    """
    line = (address.address_line1 or "").strip()
    explicit = getattr(address.address, "street_number", None)

    if explicit:
        street = " ".join(_ for _ in line.split(" ") if _ != explicit) or line
        number, addition = _split_addition(explicit)
        return street, number, addition

    match = re.match(r"^(.+?)\s+(\d+[\d/-]*)\s*([a-zA-Z][a-zA-Z0-9-]*)?$", line)

    if match is None:
        return line, "", ""

    street, number, addition = match.groups()
    return street.strip(), number.strip(), (addition or "").strip()


def _split_addition(value: str) -> typing.Tuple[str, str]:
    match = re.match(r"^(\d+[\d/-]*)\s*([a-zA-Z][a-zA-Z0-9-]*)?$", value.strip())

    if match is None:
        return value.strip(), ""

    number, addition = match.groups()
    return number, (addition or "")
