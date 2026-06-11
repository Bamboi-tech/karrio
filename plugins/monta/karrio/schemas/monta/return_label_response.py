import attr
import jstruct
import typing


@attr.s(auto_attribs=True)
class ReturnLabelResponseType:
    ShipperDescription: typing.Optional[str] = None
    TrackAndTraceCode: typing.Optional[str] = None
    TrackAndTraceLink: typing.Optional[str] = None
    Created: typing.Optional[str] = None
    DeliveryStatusCode: typing.Optional[str] = None
    DeliveryStatusDescription: typing.Optional[str] = None
    DeliveryStatusChangedUtc: typing.Optional[str] = None
    EnRouteUtc: typing.Optional[str] = None
    DeliveredUtc: typing.Optional[str] = None
