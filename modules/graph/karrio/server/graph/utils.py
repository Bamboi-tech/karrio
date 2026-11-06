from karrio.server.core.utils import *
import typing
import base64
import functools
import collections.abc
import strawberry
import dataclasses
from strawberry.types import Info
import strawberry.types.nodes as nodes
from rest_framework import exceptions
from django.utils.translation import gettext_lazy as _

import karrio.lib as lib
import karrio.server.core.utils as utils
import karrio.server.core.models as core
import karrio.server.orders.models as orders
import karrio.server.manager.models as manager
import karrio.server.providers.models as providers
import karrio.server.core.permissions as permissions
import karrio.server.core.serializers as serializers
from karrio.server.core.logging import logger

Cursor = str
T = typing.TypeVar("T")
GenericType = typing.TypeVar("GenericType")

error_logger = utils.error_wrapper

JSON: typing.Any = strawberry.scalar(
    typing.NewType("JSON", object),
    description="The `JSON` scalar type represents JSON values as specified by ECMA-404",
)
MANUAL_SHIPMENT_STATUSES = [
    (_.name, _.name)
    for _ in [
        serializers.ShipmentStatus.in_transit,
        serializers.ShipmentStatus.needs_attention,
        serializers.ShipmentStatus.delivery_failed,
        serializers.ShipmentStatus.delivered,
    ]
]

CurrencyCodeEnum: typing.Any = strawberry.enum(  # type: ignore
    lib.Enum("CurrencyCodeEnum", serializers.CURRENCIES)
)
CountryCodeEnum: typing.Any = strawberry.enum(  # type: ignore
    lib.Enum("CountryCodeEnum", serializers.COUNTRIES)
)
DimensionUnitEnum: typing.Any = strawberry.enum(  # type: ignore
    lib.Enum("DimensionUnitEnum", serializers.DIMENSION_UNIT)
)
WeightUnitEnum: typing.Any = strawberry.enum(  # type: ignore
    lib.Enum("WeightUnitEnum", serializers.WEIGHT_UNIT)
)
CustomsContentTypeEnum: typing.Any = strawberry.enum(  # type: ignore
    lib.Enum("CustomsContentTypeEnum", serializers.CUSTOMS_CONTENT_TYPE)
)
IncotermCodeEnum: typing.Any = strawberry.enum(  # type: ignore
    lib.Enum("IncotermCodeEnum", serializers.INCOTERMS)
)
PaidByEnum: typing.Any = strawberry.enum(  # type: ignore
    lib.Enum("PaidByEnum", serializers.PAYMENT_TYPES)
)
LabelTypeEnum: typing.Any = strawberry.enum(  # type: ignore
    lib.Enum("LabelTypeEnum", serializers.LABEL_TYPES)
)
LabelTemplateTypeEnum: typing.Any = strawberry.enum(  # type: ignore
    lib.Enum("LabelTemplateTypeEnum", serializers.LABEL_TEMPLATE_TYPES)
)
ShipmentStatusEnum: typing.Any = strawberry.enum(  # type: ignore
    lib.Enum("ShipmentStatusEnum", serializers.SHIPMENT_STATUS)
)
ManualShipmentStatusEnum: typing.Any = strawberry.enum(  # type: ignore
    lib.Enum("ManualShipmentStatusEnum", MANUAL_SHIPMENT_STATUSES)
)
TrackerStatusEnum: typing.Any = strawberry.enum(  # type: ignore
    lib.Enum("TrackerStatusEnum", serializers.TRACKER_STATUS)
)
CarrierNameEnum: typing.Any = strawberry.enum(  # type: ignore
    lib.Enum("CarrierNameEnum", serializers.CARRIERS)
)
MetafieldTypeEnum: typing.Any = strawberry.enum(  # type: ignore
    lib.Enum("MetafieldTypeEnum", core.METAFIELD_TYPE)
)


# ─────────────────────────────────────────────────────────────────
# Workspace Config Enums (for printing options and shipping defaults)
# ─────────────────────────────────────────────────────────────────

LABEL_SIZES = [
    ("A4", "A4"),
    ("A5", "A5"),
    ("A6", "A6"),
    ("LETTER", "LETTER"),
    ("SIZE_4_x_6", "4x6"),
    ("SIZE_4_x_8", "4x8"),
]
LabelSizeEnum: typing.Any = strawberry.enum(
    lib.Enum("LabelSizeEnum", LABEL_SIZES)
)

EXPORT_REASONS = [
    ("sale", "sale"),
    ("gift", "gift"),
    ("sample", "sample"),
    ("return", "return"),
    ("repair", "repair"),
    ("personal_effects", "personal_effects"),
    ("other", "other"),
]
ExportReasonEnum: typing.Any = strawberry.enum(
    lib.Enum("ExportReasonEnum", EXPORT_REASONS)
)

FIRST_MILE_OPTIONS = [
    ("pickup", "pickup"),
    ("drop_off", "drop_off"),
]
FirstMileEnum: typing.Any = strawberry.enum(
    lib.Enum("FirstMileEnum", FIRST_MILE_OPTIONS)
)

LAST_MILE_OPTIONS = [
    ("home_delivery", "home_delivery"),
    ("service_point", "service_point"),
    ("mailbox", "mailbox"),
    ("po_box", "po_box"),
]
LastMileEnum: typing.Any = strawberry.enum(
    lib.Enum("LastMileEnum", LAST_MILE_OPTIONS)
)

FORM_FACTOR_OPTIONS = [
    ("letter", "letter"),
    ("parcel", "parcel"),
    ("mailbox", "mailbox"),
    ("pallet", "pallet"),
    ("long", "long"),
]
FormFactorEnum: typing.Any = strawberry.enum(
    lib.Enum("FormFactorEnum", FORM_FACTOR_OPTIONS)
)

AGE_CHECK_OPTIONS = [
    ("AGE_16", "16"),
    ("AGE_18", "18"),
]
AgeCheckEnum: typing.Any = strawberry.enum(
    lib.Enum("AgeCheckEnum", AGE_CHECK_OPTIONS)
)


class MetadataObjectType(lib.Enum):
    carrier = providers.CarrierConnection
    commodity = manager.Commodity
    shipment = manager.Shipment
    tracker = manager.Tracking
    order = orders.Order


MetadataObjectTypeEnum: typing.Any = strawberry.enum(  # type: ignore
    lib.StrEnum(
        "MetadataObjectTypeEnum", [(c.name, c.name) for c in list(MetadataObjectType)]
    )
)


def authentication_required(func):
    @functools.wraps(func)
    def wrapper(info: Info, **kwargs):
        user = getattr(info.context.request, 'user', None)

        if user is None or user.is_anonymous:
            raise exceptions.AuthenticationFailed(
                _("You are not authenticated"), code="authentication_required"
            )

        if not user.is_verified():
            raise exceptions.AuthenticationFailed(
                _("Authentication Token not verified"), code="two_factor_required"
            )

        return func(info, **kwargs)

    return wrapper


def password_required(func):
    @functools.wraps(func)
    def wrapper(info: Info, **kwargs):
        password = kwargs.get("password")

        if not info.context.request.user.check_password(password):
            raise exceptions.ValidationError({"password": "Invalid password"})

        return func(info, **kwargs)

    return wrapper


def authorization_required(keys: typing.List[str] = None):
    def decorator(func):
        @functools.wraps(func)
        def wrapper(info: Info, **kwargs):
            permissions.check_permissions(
                context=info.context.request,
                keys=keys or [],
            )

            return func(info, **kwargs)

        return wrapper

    return decorator


@strawberry.type
class ErrorType:
    field: str
    messages: typing.List[str]

    @staticmethod
    def from_errors(errors):
        return []


@strawberry.input
class BaseInput:
    def pagination(self) -> typing.Dict[str, typing.Any]:
        return {
            k: v
            for k, v in dataclass_to_dict(self).items()
            if k in ["offset", "before", "after", "first", "last"]
        }

    def to_dict(self) -> typing.Dict[str, typing.Any]:
        return dataclass_to_dict(self)


@strawberry.type
class BaseMutation:
    errors: typing.Optional[typing.List[ErrorType]] = None


@strawberry.type
class UsageStatType:
    date: typing.Optional[str] = None
    label: typing.Optional[str] = None
    count: typing.Optional[float] = None
    amount: typing.Optional[float] = None
    currency: typing.Optional[str] = None

    @staticmethod
    def parse(value: dict, label: str = None) -> "UsageStatType":
        return UsageStatType(**{
            **(dict(label=label) if label else {}),
            **{k: v for k, v in value.items() if k in UsageStatType.__annotations__},
            "amount": lib.to_decimal(value.get("amount")),
        })


@strawberry.input
class UsageFilter(BaseInput):
    date_after: typing.Optional[str] = strawberry.UNSET
    date_before: typing.Optional[str] = strawberry.UNSET
    omit: typing.Optional[typing.List[str]] = strawberry.UNSET
    surcharge_id: typing.Optional[str] = strawberry.UNSET


@dataclasses.dataclass
@strawberry.type
class Connection(typing.Generic[GenericType]):
    """Represents a paginated relationship between two entities
    This pattern is used when the relationship itself has attributes.
    In a Facebook-based domain example, a friendship between two people
    would be a connection that might have a `friendshipStartTime`
    """

    page_info: "PageInfo"
    edges: typing.List["Edge[GenericType]"]


@dataclasses.dataclass
@strawberry.type
class PageInfo:
    """Pagination context to navigate objects with cursor-based pagination
    Instead of classic offset pagination via `page` and `limit` parameters,
    here we have a cursor of the last object and we fetch items starting from that one
    Read more at:
        - https://graphql.org/learn/pagination/#pagination-and-edges
        - https://relay.dev/graphql/connections.htm
    """

    # Both queries behind a connection run on demand: the page SELECT when a
    # query selects edges or cursors, the full-filter COUNT(*) when it selects
    # ``count``. A count badge never loads rows, a list without a total never
    # counts.
    page: strawberry.Private["Page"]
    count_resolver: strawberry.Private[typing.Callable[[], int]]

    @strawberry.field
    def has_next_page(self) -> bool:
        return self.page.has_next_page

    @strawberry.field
    def has_previous_page(self) -> bool:
        return False

    @strawberry.field
    def start_cursor(self) -> typing.Optional[str]:
        return self.page.start_cursor

    @strawberry.field
    def end_cursor(self) -> typing.Optional[str]:
        return self.page.end_cursor

    @strawberry.field
    def count(self) -> int:
        return self.count_resolver()


@dataclasses.dataclass
@strawberry.type
class Edge(typing.Generic[GenericType]):
    """An edge may contain additional information of the relationship. This is the trivial case"""

    node: GenericType
    cursor: str


@strawberry.input
class Paginated(BaseInput):
    offset: typing.Optional[int] = strawberry.UNSET
    first: typing.Optional[int] = strawberry.UNSET


def build_entity_cursor(entity: T):
    """Adapt this method to build an *opaque* ID from an instance"""
    entityid = f"{getattr(entity, 'id', id(entity))}".encode("utf-8")
    return base64.b64encode(entityid).decode()


class Page(collections.abc.Sequence):
    """The edges of one page, read from the database on first use."""

    def __init__(self, queryset, first: int, offset: int):
        self.queryset = queryset
        self.first = first
        self.offset = offset

    @functools.cached_property
    def fetched(self) -> typing.List[Edge]:
        # Fetch the requested results plus one, just to calculate `has_next_page`
        # fmt: off
        results = self.queryset[self.offset:self.offset+self.first+1]
        # fmt: on

        return [
            Edge(node=entity, cursor=build_entity_cursor(entity)) for entity in results
        ]

    @property
    def has_next_page(self) -> bool:
        return len(self.fetched) > self.first

    @property
    def start_cursor(self) -> typing.Optional[str]:
        return self.fetched[0].cursor if self.fetched else None

    @property
    def end_cursor(self) -> typing.Optional[str]:
        return self.fetched[-2].cursor if len(self.fetched) > 1 else None

    @functools.cached_property
    def edges(self) -> typing.List[Edge]:
        return self.fetched[:-1] if self.has_next_page else self.fetched

    def __getitem__(self, index):
        return self.edges[index]

    def __len__(self) -> int:
        return len(self.edges)


def paginated_connection(
    queryset,
    first: int = 25,
    offset: int = 0,
) -> Connection[T]:
    """Paginate a queryset without touching the database: the page and the
    total are only queried for the parts of the connection a query selects.
    """
    page = Page(queryset, first, offset)

    return Connection(
        page_info=PageInfo(page=page, count_resolver=queryset.count),
        edges=typing.cast(typing.List[typing.Any], page),
    )


def _fields_named(selections, name: str) -> typing.Iterator[nodes.SelectedField]:
    for selection in selections:
        if isinstance(selection, nodes.SelectedField):
            if selection.name == name:
                yield selection
        else:  # a fragment spread or inline fragment: look inside
            yield from _fields_named(selection.selections, name)


def selects(info: Info, *path: str) -> bool:
    """Whether the operation selects ``path`` under the field being resolved,
    e.g. ``selects(info, "edges", "node", "tracker")`` on a connection.
    """
    fields = info.selected_fields
    for name in path:
        fields = [child for field in fields for child in _fields_named(field.selections, name)]
    return bool(fields)


def is_unset(v: typing.Any) -> bool:
    return isinstance(v, type(strawberry.UNSET)) or v == strawberry.UNSET


def _dict_factory(items):
    if isinstance(next(iter(items), None), tuple):
        return dict(
            [
                (key, _dict_factory(value) if isinstance(value, list) else value)
                for key, value in items
                if not is_unset(value)
            ]
        )

    return items


def dataclass_to_dict(data):
    return lib.to_dict(
        dataclasses.asdict(
            data,
            dict_factory=_dict_factory,
        ),
        clear_empty=False,
    )
