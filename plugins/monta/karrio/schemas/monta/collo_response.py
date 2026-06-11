import attr
import jstruct
import typing


@attr.s(auto_attribs=True)
class ProductType:
    Sku: typing.Optional[str] = None
    Quantity: typing.Optional[int] = None


@attr.s(auto_attribs=True)
class ColloResponseType:
    Number: typing.Optional[int] = None
    WeightGrammes: typing.Optional[int] = None
    LengthMm: typing.Optional[int] = None
    WidthMm: typing.Optional[int] = None
    HeightMm: typing.Optional[int] = None
    TrackAndTraceCode: typing.Optional[str] = None
    TrackAndTraceLink: typing.Optional[str] = None
    DeliveryStatusDescription: typing.Optional[str] = None
    DeliveryStatusCode: typing.Optional[str] = None
    DeliveryStatusUpdated: typing.Optional[str] = None
    PackageDescription: typing.Optional[str] = None
    IsParent: typing.Optional[bool] = None
    ParentNumber: typing.Optional[int] = None
    Products: typing.Optional[typing.List[ProductType]] = jstruct.JList[ProductType]
