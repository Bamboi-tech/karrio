import attr
import jstruct
import typing


@attr.s(auto_attribs=True)
class OrderEventResponseType:
    Id: typing.Optional[int] = None
    WebshopOrderId: typing.Optional[str] = None
    TypeCode: typing.Optional[str] = None
    TypeId: typing.Optional[int] = None
    Description: typing.Optional[str] = None
    Occured: typing.Optional[str] = None
    Created: typing.Optional[str] = None
    EorderID: typing.Optional[int] = None
