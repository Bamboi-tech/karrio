"""Bamboi fork: an expired or malformed refresh token is a session ending and
answers 401 like simplejwt's own TokenViewBase, instead of falling through
the exception handler as a 500 (KARRIO-PROD-PYTHON-DJANGO-K)."""

from datetime import timedelta

from rest_framework_simplejwt.tokens import RefreshToken

from karrio.server.core.tests.base import APITestCase


def _refresh_token(user, expired=False) -> str:
    token = RefreshToken.for_user(user)
    token["is_verified"] = True
    if expired:
        token.set_exp(lifetime=timedelta(seconds=-1))
    return str(token)


class TestTokenRefresh(APITestCase):
    def test_expired_refresh_token_is_a_401(self):
        response = self.client.post(
            "/api/token/refresh",
            {"refresh": _refresh_token(self.user, expired=True)},
            format="json",
        )
        self.assertEqual(response.status_code, 401)
        error = response.data["errors"][0]
        self.assertEqual(error["code"], "token_not_valid")
        self.assertIn("expired", error["message"].lower())

    def test_malformed_refresh_token_is_a_401(self):
        response = self.client.post(
            "/api/token/refresh", {"refresh": "not-a-jwt"}, format="json"
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.data["errors"][0]["code"], "token_not_valid")

    def test_valid_refresh_token_still_issues_a_pair(self):
        response = self.client.post(
            "/api/token/refresh", {"refresh": _refresh_token(self.user)}, format="json"
        )
        self.assertEqual(response.status_code, 201)
        self.assertIn("access", response.data)
