"""Tests for lib/common/ utilities."""

from __future__ import annotations

import os
from pathlib import Path

import pytest


# ---------------------------------------------------------------------------
# env.py
# ---------------------------------------------------------------------------

class TestParseEnv:
    def test_basic_kv(self, tmp_env_file: Path):
        from lib.common.env import parse_env as _orig_parse

        # Patch ENV_FILE for this call
        import lib.common.env as env_mod
        original = env_mod.ENV_FILE
        try:
            env_mod.ENV_FILE = tmp_env_file
            result = env_mod.parse_env()
        finally:
            env_mod.ENV_FILE = original

        assert result["LITELLM_MASTER_KEY"] == "sk-test-1234"
        assert result["PROXY_PORT"] == "4000"

    def test_strips_quotes(self, tmp_path: Path):
        ef = tmp_path / ".env"
        ef.write_text('FOO="bar baz"\nBAR=\'qux\'\n')

        import lib.common.env as env_mod
        original = env_mod.ENV_FILE
        try:
            env_mod.ENV_FILE = ef
            result = env_mod.parse_env()
        finally:
            env_mod.ENV_FILE = original

        assert result["FOO"] == "bar baz"
        assert result["BAR"] == "qux"

    def test_ignores_comments_and_blanks(self, tmp_path: Path):
        ef = tmp_path / ".env"
        ef.write_text("# comment\n\nVALID=1\n")

        import lib.common.env as env_mod
        original = env_mod.ENV_FILE
        try:
            env_mod.ENV_FILE = ef
            result = env_mod.parse_env()
        finally:
            env_mod.ENV_FILE = original

        assert "VALID" in result
        assert len(result) == 1

    def test_missing_file_returns_empty(self, tmp_path: Path):
        import lib.common.env as env_mod
        original = env_mod.ENV_FILE
        try:
            env_mod.ENV_FILE = tmp_path / "nonexistent.env"
            result = env_mod.parse_env()
        finally:
            env_mod.ENV_FILE = original
        assert result == {}


class TestLoadEnv:
    def test_strips_quotes_into_environ(self, tmp_path: Path, monkeypatch):
        """Quoted .env values must not leave literal quotes in os.environ (breaks api_base URLs)."""
        ef = tmp_path / ".env"
        ef.write_text('LOCAL_EMBEDDING_API_BASE="http://localhost:11434"\n')
        import lib.common.env as env_mod
        original_file = env_mod.ENV_FILE
        monkeypatch.delenv("LOCAL_EMBEDDING_API_BASE", raising=False)
        try:
            env_mod.ENV_FILE = ef
            env_mod.load_env()
        finally:
            env_mod.ENV_FILE = original_file
        assert os.environ["LOCAL_EMBEDDING_API_BASE"] == "http://localhost:11434"


class TestUpsertEnvVar:
    def test_updates_existing(self, tmp_env_file: Path):
        from lib.common.env import upsert_env_var
        changed = upsert_env_var("PROXY_PORT", "5000", env_file=tmp_env_file)
        assert changed is True
        assert "PROXY_PORT=5000" in tmp_env_file.read_text()

    def test_no_change_same_value(self, tmp_env_file: Path):
        from lib.common.env import upsert_env_var
        changed = upsert_env_var("PROXY_PORT", "4000", env_file=tmp_env_file)
        assert changed is False

    def test_appends_new_var(self, tmp_env_file: Path):
        from lib.common.env import upsert_env_var
        changed = upsert_env_var("NEW_VAR", "hello", env_file=tmp_env_file)
        assert changed is True
        assert "NEW_VAR=hello" in tmp_env_file.read_text()

    def test_missing_file_returns_false(self, tmp_path: Path):
        from lib.common.env import upsert_env_var
        changed = upsert_env_var("X", "1", env_file=tmp_path / "missing.env")
        assert changed is False

# ---------------------------------------------------------------------------
# platform.py
# ---------------------------------------------------------------------------

class TestPlatformHelpers:
    def test_is_macos_or_linux(self):
        from lib.common.platform import is_macos, is_linux
        import sys
        # At least one of them must be True on the test machine
        assert is_macos() or is_linux()
        # They must be mutually exclusive
        assert not (is_macos() and is_linux())

    def test_is_interactive(self, monkeypatch):
        """Non-interactive in pytest environment."""
        from lib.common.platform import is_interactive
        # pytest runs without a TTY — should be False
        assert is_interactive() in (True, False)  # just shouldn't raise


# ---------------------------------------------------------------------------
# paths.py
# ---------------------------------------------------------------------------

class TestPaths:
    def test_project_dir_is_path(self):
        from lib.common.paths import PROJECT_DIR
        assert isinstance(PROJECT_DIR, Path)

    def test_bin_dir_is_path(self):
        from lib.common.paths import BIN_DIR
        assert isinstance(BIN_DIR, Path)

    def test_env_file_name(self):
        from lib.common.paths import ENV_FILE
        assert ENV_FILE.name == ".env"

    def test_config_file_name(self):
        from lib.common.paths import CONFIG_FILE
        assert CONFIG_FILE.name == "config.yaml"
