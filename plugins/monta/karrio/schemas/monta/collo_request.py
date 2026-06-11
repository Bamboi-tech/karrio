import attr
import jstruct
import typing


@attr.s(auto_attribs=True)
class ColloRequestType:
    Number: typing.Optional[int] = None
    WeightGrammes: typing.Optional[int] = None
    LengthMm: typing.Optional[int] = None
    WidthMm: typing.Optional[int] = None
    HeightMm: typing.Optional[int] = None
    PackageDescription: typing.Optional[str] = None
