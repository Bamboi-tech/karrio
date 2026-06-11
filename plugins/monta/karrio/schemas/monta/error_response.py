import attr
import jstruct
import typing


@attr.s(auto_attribs=True)
class OrderInvalidReasonType:
    Code: typing.Optional[int] = None
    Message: typing.Optional[str] = None


@attr.s(auto_attribs=True)
class ErrorResponseType:
    OrderInvalidReasons: typing.Optional[typing.List[OrderInvalidReasonType]] = jstruct.JList[OrderInvalidReasonType]
