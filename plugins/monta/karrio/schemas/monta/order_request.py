import attr
import jstruct
import typing


@attr.s(auto_attribs=True)
class AddressType:
    Company: typing.Optional[str] = None
    FirstName: typing.Optional[str] = None
    MiddleName: typing.Optional[str] = None
    LastName: typing.Optional[str] = None
    Street: typing.Optional[str] = None
    HouseNumber: typing.Optional[str] = None
    HouseNumberAddition: typing.Optional[str] = None
    PostalCode: typing.Optional[str] = None
    City: typing.Optional[str] = None
    State: typing.Optional[str] = None
    CountryCode: typing.Optional[str] = None
    PhoneNumber: typing.Optional[str] = None
    EmailAddress: typing.Optional[str] = None


@attr.s(auto_attribs=True)
class ConsumerDetailsType:
    DeliveryAddress: typing.Optional[AddressType] = jstruct.JStruct[AddressType]
    InvoiceAddress: typing.Optional[AddressType] = jstruct.JStruct[AddressType]
    B2B: typing.Optional[bool] = None
    ShippingComment: typing.Optional[str] = None
    CommunicationLanguageCode: typing.Optional[str] = None


@attr.s(auto_attribs=True)
class LineType:
    Sku: typing.Optional[str] = None
    OrderedQuantity: typing.Optional[int] = None
    WebshopOrderLineId: typing.Optional[str] = None
    Description: typing.Optional[str] = None


@attr.s(auto_attribs=True)
class OrderRequestType:
    WebshopOrderId: typing.Optional[str] = None
    Reference: typing.Optional[str] = None
    Origin: typing.Optional[str] = None
    ConsumerDetails: typing.Optional[ConsumerDetailsType] = jstruct.JStruct[ConsumerDetailsType]
    PlannedShipmentDate: typing.Optional[str] = None
    ShipOnPlannedShipmentDate: typing.Optional[bool] = None
    ShipperCode: typing.Optional[str] = None
    DeliveryDateRequested: typing.Optional[str] = None
    Lines: typing.Optional[typing.List[LineType]] = jstruct.JList[LineType]
    AllowedShippers: typing.Optional[typing.List[str]] = None
    Comment: typing.Optional[str] = None
