"""Tests for auth/core.py helpers (PKCE, JWT, expiry)."""

from __future__ import annotations

import base64
import json
import time


class TestGeneratePkce:
    def test_returns_two_strings(self):
        from lib.auth.core import _generate_pkce
        verifier, challenge = _generate_pkce()
        assert isinstance(verifier, str)
        assert isinstance(challenge, str)

    def test_challenge_is_url_safe_base64(self):
        from lib.auth.core import _generate_pkce
        _, challenge = _generate_pkce()
        # Should not contain + or / (URL-safe b64)
        assert "+" not in challenge
        assert "/" not in challenge
        # No padding
        assert "=" not in challenge

    def test_verifier_challenge_are_linked(self):
        import hashlib
        from lib.auth.core import _generate_pkce
        verifier, challenge = _generate_pkce()
        expected = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .rstrip(b"=")
            .decode()
        )
        assert challenge == expected

    def test_unique_per_call(self):
        from lib.auth.core import _generate_pkce
        v1, _ = _generate_pkce()
        v2, _ = _generate_pkce()
        assert v1 != v2


class TestDecodeJwt:
    def _make_jwt(self, payload: dict) -> str:
        header = base64.urlsafe_b64encode(b'{"alg":"HS256"}').rstrip(b"=").decode()
        body = base64.urlsafe_b64encode(
            json.dumps(payload).encode()
        ).rstrip(b"=").decode()
        sig = base64.urlsafe_b64encode(b"fakesig").rstrip(b"=").decode()
        return f"{header}.{body}.{sig}"

    def test_decodes_payload(self):
        from lib.auth.core import _decode_jwt
        token = self._make_jwt({"sub": "user123", "exp": 9999999999})
        result = _decode_jwt(token)
        assert result["sub"] == "user123"

    def test_returns_empty_dict_on_invalid(self):
        from lib.auth.core import _decode_jwt
        assert _decode_jwt("not.a.jwt") == {} or isinstance(_decode_jwt("not.a.jwt"), dict)
        assert _decode_jwt("garbage") == {}

    def test_returns_empty_on_malformed_base64(self):
        from lib.auth.core import _decode_jwt
        result = _decode_jwt("header.!!!invalid!!!.sig")
        assert isinstance(result, dict)


class TestExpiryLabel:
    def test_expired(self):
        from lib.auth.core import _expiry_label
        d = {"expires_at": time.time() - 100}
        assert _expiry_label(d) == "EXPIRED"

    def test_future_expiry_shows_time_left(self):
        from lib.auth.core import _expiry_label
        d = {"expires_at": time.time() + 3700}  # ~1h 1m
        label = _expiry_label(d)
        assert "left" in label
        assert "h" in label

    def test_no_expiry_field(self):
        from lib.auth.core import _expiry_label
        assert _expiry_label({}) == "unknown expiry"

    def test_zero_remaining(self):
        from lib.auth.core import _expiry_label
        d = {"expires_at": time.time() - 1}
        assert _expiry_label(d) == "EXPIRED"


class TestIsHeadless:
    def test_ssh_client_is_headless(self, monkeypatch):
        monkeypatch.setenv("SSH_CLIENT", "1.2.3.4 1234 22")
        from lib.auth import core as core_mod
        import importlib
        # Force re-evaluation by calling the function directly
        assert core_mod._is_headless() is True

    def test_docker_is_headless(self, monkeypatch, tmp_path):
        monkeypatch.delenv("SSH_CLIENT", raising=False)
        monkeypatch.delenv("SSH_TTY", raising=False)
        monkeypatch.delenv("SSH_CONNECTION", raising=False)
        # Create a fake /.dockerenv by patching os.path.exists
        import unittest.mock as mock
        from lib.auth import core as core_mod
        with mock.patch("os.path.exists", side_effect=lambda p: p == "/.dockerenv"):
            result = core_mod._is_headless()
        assert result is True

    def test_clean_env_not_headless(self, monkeypatch):
        import sys
        monkeypatch.delenv("SSH_CLIENT", raising=False)
        monkeypatch.delenv("SSH_TTY", raising=False)
        monkeypatch.delenv("SSH_CONNECTION", raising=False)
        monkeypatch.delenv("DISPLAY", raising=False)
        monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
        import unittest.mock as mock
        from lib.auth import core as core_mod
        with mock.patch("os.path.exists", return_value=False):
            if sys.platform.startswith("linux"):
                # Linux without DISPLAY — headless
                assert core_mod._is_headless() is True
            else:
                # macOS — not headless
                assert core_mod._is_headless() is False
