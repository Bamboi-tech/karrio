"""Warm response cache for the shipments board.

A designated user's (``SHIPMENTS_WARM_USERS``) ``get_shipments_list`` and
``shipment_badge_counts`` responses are kept in the Django cache, tagged with
the shipments data version (``karrio.server.core.warm_cache``), and served by
the GraphQL view before Strawberry parses or executes anything. Every write
to a shipment or tracker row moves the version (every body becomes a miss)
and a debounced huey task (``karrio.server.graph.tasks``) re-executes the
operation sets each user recently used. See PRDs/SHIPMENTS_WARM_LIST_CACHE.md.
"""

import re
import json
import typing
import hashlib
import dataclasses
from django.conf import settings
from django.core.cache import cache
from django.http import HttpRequest
from django.contrib.auth import get_user_model
from rest_framework import exceptions
from strawberry.types.graphql import OperationType
from strawberry.schema.exceptions import (
    InvalidOperationTypeError,
    CannotGetOperationTypeError,
)

import karrio.server.core.warm_cache as core
import karrio.server.core.authentication as authentication
from karrio.server.core.logging import logger

OPERATIONS = frozenset({"get_shipments_list", "shipment_badge_counts"})
RECENT_SETS = 8  # distinct (operation, query, variables) sets kept per scope
RECENT_TTL = 24 * 60 * 60
BODY_TTL = 24 * 60 * 60  # housekeeping only: a version mismatch is a miss anyway
DEBOUNCE_SECONDS = 2
PENDING_TTL = 30  # a scheduled run that never started stops blocking new ones
SCOPES_KEY = "shipments_warm:scopes"
PENDING_KEY = "shipments_warm:pending"
OPERATION_RE = re.compile(r"\s*query\s+([A-Za-z_][A-Za-z0-9_]*)\b")


@dataclasses.dataclass(frozen=True)
class Scope:
    """Whose data a body holds: a user, in an org, in live or test mode."""

    user_pk: typing.Any
    org_pk: typing.Optional[str]
    test_mode: bool


@dataclasses.dataclass(frozen=True)
class Operation:
    """One (operation, query text, variables) set as the client sends it."""

    name: str
    query: str
    variables: typing.Optional[dict]

    @property
    def digest(self) -> str:
        payload = json.dumps(
            [self.name, self.query, self.variables],
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(payload.encode()).hexdigest()[:32]


def body_key(scope: Scope, operation: Operation) -> str:
    return f"shipments_warm:body:{scope_key(scope)}:{operation.digest}"


def recent_key(scope: Scope) -> str:
    return f"shipments_warm:recent:{scope_key(scope)}"


def scope_key(scope: Scope) -> str:
    return f"{scope.user_pk}:{scope.org_pk or ''}:{int(bool(scope.test_mode))}"


def request_entry(
    request: HttpRequest,
) -> typing.Optional[typing.Tuple[Scope, Operation]]:
    """What a request maps to, or None when it is not cacheable: feature off,
    not a designated user, not a JSON POST, or not an allowed query."""
    if not core.enabled() or request.method != "POST":
        return None
    if request.content_type != "application/json":
        return None

    try:
        user = getattr(request, "user", None)
        if not core.is_warm_user(user):
            return None
    except exceptions.AuthenticationFailed:
        return None  # the normal path raises the same error from the resolver

    try:
        operation = parse_operation(json.loads(request.body))
    except ValueError:
        return None
    if operation is None:
        return None

    org = getattr(request, "org", None)
    scope = Scope(
        user.pk, getattr(org, "id", None), bool(getattr(request, "test_mode", False))
    )
    return scope, operation


def parse_operation(data: typing.Any) -> typing.Optional[Operation]:
    """The allowed query a GraphQL request body carries, or None. The document
    must start with ``query <allowed name>``, so a mutation or a multi-operation
    document never enters the cache; an explicit operationName must agree."""
    if not isinstance(data, dict):
        return None
    query, variables = data.get("query"), data.get("variables")
    if not isinstance(query, str) or not isinstance(variables, (dict, type(None))):
        return None

    found = OPERATION_RE.match(query)
    if found is None or found.group(1) not in OPERATIONS:
        return None
    if data.get("operationName", data.get("operation_name")) not in (
        None,
        found.group(1),
    ):
        return None

    return Operation(found.group(1), query, variables)


def lookup(
    scope: Scope, operation: Operation
) -> typing.Tuple[typing.Optional[int], typing.Optional[bytes]]:
    """The current version and, when a body is tagged with it, that body. A
    miss executes and stores its body under this version (``store``)."""
    key = body_key(scope, operation)
    try:
        found = cache.get_many([core.VERSION_KEY, key])
    except Exception as e:
        logger.warning("Warm cache lookup failed", error=str(e))
        return None, None

    version = found.get(core.VERSION_KEY)
    if version is None:
        version = core.data_version()  # first request after a deploy or a flush
    cached = found.get(key)
    if version is not None and cached is not None and cached[0] == version:
        return version, cached[1]

    return version, None


def store(scope: Scope, operation: Operation, version: int, body: bytes) -> None:
    """Keep the body a miss produced, tagged with the version read before it
    executed, and remember the operation set for the warmer."""
    try:
        cache.set(body_key(scope, operation), (version, body), BODY_TTL)
        key = recent_key(scope)
        recent = [
            item
            for item in (cache.get(key) or [])
            if (item["query"], item["variables"])
            != (operation.query, operation.variables)
        ]
        cache.set(
            key, [dataclasses.asdict(operation), *recent][:RECENT_SETS], RECENT_TTL
        )
        scopes = cache.get(SCOPES_KEY) or []
        if dataclasses.astuple(scope) not in scopes:
            cache.set(SCOPES_KEY, [*scopes, dataclasses.astuple(scope)], RECENT_TTL)
    except Exception as e:
        logger.warning("Warm cache store failed", error=str(e))


def scopes() -> typing.List[Scope]:
    return [Scope(*values) for values in (cache.get(SCOPES_KEY) or [])]


def warm() -> int:
    """Re-execute, for every remembered scope, the recent operation sets
    whose body is missing or behind the current version; returns how many
    bodies were stored."""
    version = core.data_version()
    if version is None:
        return 0

    return sum(warm_scope(scope, version) for scope in scopes())


def warm_scope(scope: Scope, version: int) -> int:
    key = recent_key(scope)
    recent = cache.get(key)
    if not recent:
        return 0
    cache.touch(key, RECENT_TTL)
    cache.touch(SCOPES_KEY, RECENT_TTL)

    request = request_for(scope)
    if request is None:
        return 0

    operations = {
        body_key(scope, op): op for op in (Operation(**item) for item in recent)
    }
    current = cache.get_many(list(operations))
    stored = 0
    for key, operation in operations.items():
        cached = current.get(key)
        if cached is not None and cached[0] == version:
            continue
        body = render(request, operation)
        if body is not None:
            cache.set(key, (version, body), BODY_TTL)
            stored += 1

    return stored


def request_for(scope: Scope) -> typing.Optional[HttpRequest]:
    """A request context equivalent to the user's own authenticated request,
    without HTTP. None when the user is gone or no longer designated."""
    user = get_user_model().objects.filter(pk=scope.user_pk, is_active=True).first()
    if user is None or not core.is_warm_user(user):
        return None

    org = None
    if scope.org_pk is not None:
        if not settings.MULTI_ORGANIZATIONS:
            return None
        from karrio.server.orgs.models import Organization

        org = Organization.objects.filter(id=scope.org_pk, is_active=True).first()
        if org is None:
            return None

    request = HttpRequest()
    request.method = "POST"
    request.otp_is_verified = True
    request.test_mode = scope.test_mode
    request.org = org
    request.user = authentication.get_request_user(request, user)
    return request


def render(request: HttpRequest, operation: Operation) -> typing.Optional[bytes]:
    """The body the GraphQL view would send for the operation, or None when
    the result carries errors (never cached). Queries only."""
    import karrio.server.graph.views as views
    import karrio.server.graph.schema as schema

    view = views.GraphQLView(schema=schema.schema)
    try:
        result = schema.schema.execute_sync(
            operation.query,
            variable_values=operation.variables,
            context_value=view.get_context(
                request, response=view.get_sub_response(request)
            ),
            root_value=view.get_root_value(request),
            operation_name=operation.name,
            allowed_operation_types={OperationType.QUERY},
        )
    except (InvalidOperationTypeError, CannotGetOperationTypeError):
        return None
    if result.errors:
        return None

    return view.encode_json(view.process_result(request, result)).encode("utf-8")


def schedule(sender=None, **kwargs) -> None:
    """Receiver of ``core.shipments_changed``: one warm run per burst of
    changes, ``DEBOUNCE_SECONDS`` after the first."""
    try:
        if not cache.add(PENDING_KEY, 1, PENDING_TTL):
            return  # a run is already scheduled and will read the latest version
    except Exception as e:
        logger.warning("Warm cache schedule failed", error=str(e))
        return

    import karrio.server.graph.tasks as tasks

    if tasks.huey_instance.immediate:
        tasks.warm_shipments_lists()  # the in-memory schedule has no consumer
    else:
        tasks.warm_shipments_lists.schedule(delay=DEBOUNCE_SECONDS)


def register_signals() -> None:
    core.shipments_changed.connect(schedule, dispatch_uid="graph.warm_cache.schedule")
