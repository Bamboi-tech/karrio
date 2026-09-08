import json
import hashlib
import yaml  # type: ignore
from rest_framework import status
from rest_framework.decorators import api_view, renderer_classes, permission_classes, authentication_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.request import Request
from rest_framework.renderers import JSONRenderer
from django.urls import path
from django.conf import settings
from django.core.cache import cache
from django.utils import translation

from karrio.server.conf import FEATURE_FLAGS
from karrio.server.core.router import router
import karrio.server.core.dataunits as dataunits
import karrio.server.openapi as openapi

ENDPOINT_ID = "&&"  # This endpoint id is used to make operation ids unique make sure not to duplicate
BASE_PATH = getattr(settings, "BASE_PATH", "")
REFERENCES_CACHE_TTL = 300
References = openapi.OpenApiResponse(
    openapi.OpenApiTypes.OBJECT,
    examples=[
        openapi.OpenApiExample(
            name="References",
            value={
                "VERSION": "",
                "APP_NAME": "",
                "APP_WEBSITE": "",
                "HOST": "",
                "ADMIN": "",
                "OPENAPI": "",
                "GRAPHQL": "",
                **{flag: True for flag in FEATURE_FLAGS},
                "ADDRESS_AUTO_COMPLETE": {},
                "countries": {},
                "currencies": {},
                "carriers": {},
                "customs_content_type": {},
                "incoterms": {},
                "states": {},
                "services": {},
                "connection_configs": {},
                "service_names": {},
                "options": {},
                "option_names": {},
                "package_presets": {},
                "packaging_types": {},
                "payment_types": {},
                "carrier_capabilities": {},
                "service_levels": {},
                "integration_status": {},
            },
        )
    ],
)


@openapi.extend_schema(
    auth=[],
    methods=["get"],
    tags=["API"],
    operation_id=f"{ENDPOINT_ID}data",
    summary="Data References",
    responses={200: References},
)
@api_view(["GET"])
@authentication_classes([])
@permission_classes([AllowAny])
@renderer_classes([JSONRenderer])
def references(request: Request):
    try:
        reduced = bool(yaml.safe_load(request.query_params.get("reduced", "true")))

        lang = request.query_params.get("lang")
        if lang:
            supported = {code for code, _ in settings.LANGUAGES}
            if lang not in supported:
                return Response(
                    {"error": f"Unsupported language: {lang}. Supported: {sorted(supported)}"},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        language = lang or getattr(request, "LANGUAGE_CODE", settings.LANGUAGE_CODE)
        cache_key = _references_cache_key(request, language, reduced)
        entry = cache.get(cache_key)

        if entry is None:
            from karrio.core.i18n import translate_references

            with translation.override(language):
                data = dataunits.contextual_reference(reduced=reduced)
                data = translate_references(data)

            entry = dict(etag=_etag(data), data=data)
            cache.set(cache_key, entry, REFERENCES_CACHE_TTL)

        if _matches_if_none_match(request, entry["etag"]):
            return Response(
                status=status.HTTP_304_NOT_MODIFIED, headers={"ETag": entry["etag"]}
            )

        return Response(
            entry["data"], status=status.HTTP_200_OK, headers={"ETag": entry["etag"]}
        )
    except Exception as e:
        from karrio.server.core.logging import logger

        logger.exception("Failed to retrieve references", error=str(e))
        raise e


def _references_cache_key(request: Request, language: str, reduced: bool) -> str:
    """Scope cached references by origin, organization, mode and user.

    The view runs without DRF authenticators, so the caller is read off the
    underlying Django request the auth middleware already populated — the
    same object ``contextual_reference`` consults for the user's carriers.
    """
    raw = getattr(request, "_request", request)
    user = getattr(raw, "user", None)
    user_id = (
        getattr(user, "id", None) if getattr(user, "is_authenticated", False) else None
    )
    return ":".join(
        str(part)
        for part in (
            "references",
            dataunits.get_references_version(),
            request.build_absolute_uri("/"),
            getattr(getattr(raw, "org", None), "pk", None),
            language,
            int(reduced),
            getattr(raw, "test_mode", None),
            user_id or "anon",
        )
    )


def _etag(data: dict) -> str:
    digest = hashlib.sha1(
        json.dumps(data, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()
    return f'"{digest}"'


def _matches_if_none_match(request: Request, etag: str) -> bool:
    header = request.META.get("HTTP_IF_NONE_MATCH", "")
    offered = {
        tag.strip().removeprefix("W/").strip('"')
        for tag in header.split(",")
        if tag.strip()
    }
    return "*" in offered or etag.strip('"') in offered


router.urls.append(path("references", references))
