"""Tests for database URL parsing and env patching."""

from __future__ import annotations

import os
from pathlib import Path


class TestDbNameFromUrl:
    def test_extracts_db_name(self, monkeypatch):
        monkeypatch.delenv("DATABASE_URL", raising=False)
        from lib.commands.db import db_name_from_url
        assert db_name_from_url("postgresql://user:pass@localhost/mydb") == "mydb"

    def test_extracts_db_name_with_query(self, monkeypatch):
        monkeypatch.delenv("DATABASE_URL", raising=False)
        from lib.commands.db import db_name_from_url
        assert db_name_from_url("postgresql://user@localhost/mydb?sslmode=disable") == "mydb"

    def test_falls_back_to_litellm_default(self, monkeypatch):
        monkeypatch.delenv("DATABASE_URL", raising=False)
        from lib.commands.db import db_name_from_url
        assert db_name_from_url("") == "litellm"

    def test_uses_env_var_when_no_arg(self, monkeypatch):
        monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@host/envdb")
        from lib.commands.db import db_name_from_url
        assert db_name_from_url() == "envdb"


class TestDbUserFromUrl:
    def test_extracts_user(self, monkeypatch):
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.delenv("PGUSER", raising=False)
        from lib.commands.db import db_user_from_url
        assert db_user_from_url("postgresql://alice:secret@localhost/db") == "alice"

    def test_falls_back_to_env_default(self, monkeypatch):
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.setenv("PGUSER", "pgowner")
        from lib.commands.db import db_user_from_url
        assert db_user_from_url("") == "pgowner"

    def test_no_user_in_url_uses_default(self, monkeypatch):
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.setenv("USER", "sysuser")
        monkeypatch.delenv("PGUSER", raising=False)
        from lib.commands.db import db_user_from_url
        # URL without user component
        assert db_user_from_url("postgresql://localhost/mydb") == "sysuser"


class TestAppendLinuxSocketParam:
    def test_adds_socket_on_linux(self, monkeypatch):
        import sys
        import lib.commands.db as db_mod

        monkeypatch.setattr("lib.common.platform.is_linux", lambda: True)
        monkeypatch.setattr("lib.commands.db.is_linux", lambda: True)
        from lib.commands.db import append_linux_socket_host_param

        url = "postgresql://user:pass@localhost/db"
        result = append_linux_socket_host_param(url)
        assert "host=" in result

    def test_noop_if_host_already_present(self, monkeypatch):
        monkeypatch.setattr("lib.commands.db.is_linux", lambda: True)
        from lib.commands.db import append_linux_socket_host_param

        url = "postgresql://user:pass@localhost/db?host=%2Ftmp"
        result = append_linux_socket_host_param(url)
        assert result == url

    def test_noop_on_macos(self, monkeypatch):
        monkeypatch.setattr("lib.commands.db.is_linux", lambda: False)
        from lib.commands.db import append_linux_socket_host_param

        url = "postgresql://user:pass@localhost/db"
        result = append_linux_socket_host_param(url)
        assert result == url


class TestPatchLocalDefaults:
    def test_adds_defaults(self, empty_env_file: Path):
        from lib.common.env import patch_local_defaults
        dirty = patch_local_defaults(env_file=empty_env_file)
        assert dirty is True
        text = empty_env_file.read_text()
        assert "LOCAL_EMBEDDING_API_BASE" in text
        assert "LOCAL_TRANSCRIPTION_API_BASE" in text

    def test_idempotent(self, empty_env_file: Path):
        from lib.common.env import patch_local_defaults
        patch_local_defaults(env_file=empty_env_file)
        dirty2 = patch_local_defaults(env_file=empty_env_file)
        assert dirty2 is False
