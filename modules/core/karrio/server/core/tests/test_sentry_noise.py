"""Bamboi fork: Sentry keeps the errors somebody will act on. Scanner probes
on the API root, token expiry on the auth endpoints and the ERP saying "no"
are handled 4xx nobody will ever act on, so before_send drops them — in both
shapes custom_exception_handler produces (telemetry capture and the loguru
sink). See karrio.server.settings.apm."""

import unittest

from karrio.server.settings.apm import _sentry_before_send


def _event(transaction, exception_type=None, loguru_type=None, **extra):
    event = {"transaction": transaction, **extra}
    if exception_type:
        event["exception"] = {"values": [{"type": exception_type, "value": "x"}]}
    if loguru_type:
        event["contexts"] = {"loguru": {"exception_type": loguru_type}}
    return event


class TestSentryNoise(unittest.TestCase):
    def test_root_probes_are_dropped(self):
        for exception_type in ("MethodNotAllowed", "NotAcceptable"):
            with self.subTest(exception_type=exception_type):
                self.assertIsNone(_sentry_before_send(_event("/", exception_type), {}))
                self.assertIsNone(
                    _sentry_before_send(_event("/", loguru_type=exception_type), {})
                )

    def test_same_exceptions_elsewhere_are_kept(self):
        for exception_type in ("MethodNotAllowed", "NotAcceptable"):
            with self.subTest(exception_type=exception_type):
                self.assertIsNotNone(
                    _sentry_before_send(_event("/v1/shipments", exception_type), {})
                )

    def test_token_failures_on_auth_endpoints_are_dropped(self):
        for transaction in ("/api/token", "/api/token/refresh", "/api/token/verified"):
            for exception_type in (
                "InvalidToken",
                "ExpiredTokenError",
                "TokenError",
                "AuthenticationFailed",
            ):
                with self.subTest(
                    transaction=transaction, exception_type=exception_type
                ):
                    self.assertIsNone(
                        _sentry_before_send(_event(transaction, exception_type), {})
                    )
                    self.assertIsNone(
                        _sentry_before_send(
                            _event(transaction, loguru_type=exception_type), {}
                        )
                    )

    def test_auth_failures_on_api_endpoints_are_kept(self):
        self.assertIsNotNone(
            _sentry_before_send(_event("/v1/shipments", "AuthenticationFailed"), {})
        )

    def test_erp_refusal_is_dropped_everywhere(self):
        self.assertIsNone(
            _sentry_before_send(_event("/v1/shipments/{pk}/purchase", "ERPRefusal"), {})
        )
        self.assertIsNone(
            _sentry_before_send(
                _event("/v1/shipments/{pk}/erp/{action}", loguru_type="ERPRefusal"), {}
            )
        )

    def test_erp_outage_is_kept(self):
        # Unreachable/unconfigured ERP stays a plain APIException — the loud one.
        self.assertIsNotNone(
            _sentry_before_send(
                _event("/v1/shipments/{pk}/erp/{action}", "APIException"), {}
            )
        )

    def test_kept_events_are_still_scrubbed(self):
        event = _event(
            "/v1/shipments",
            "ValidationError",
            request={
                "headers": {"authorization": "Token x"},
                "data": {"refresh_token": "y"},
            },
        )
        result = _sentry_before_send(event, {})
        self.assertEqual(result["request"]["headers"]["authorization"], "[Filtered]")
        self.assertEqual(result["request"]["data"]["refresh_token"], "[Filtered]")
