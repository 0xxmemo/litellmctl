"""Shared pytest fixtures."""

from __future__ import annotations

import os
from pathlib import Path

import pytest


@pytest.fixture()
def tmp_env_file(tmp_path: Path) -> Path:
    """A temporary .env file pre-seeded with sample values."""
    ef = tmp_path / ".env"
    ef.write_text(
        "# LiteLLM config\n"
        "LITELLM_MASTER_KEY=sk-test-1234\n"
        'DATABASE_URL=postgresql://user:pass@localhost/litellm\n'
        "PROXY_PORT=4000\n"
    )
    return ef


@pytest.fixture()
def empty_env_file(tmp_path: Path) -> Path:
    """An empty .env file."""
    ef = tmp_path / ".env"
    ef.write_text("")
    return ef


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Remove stray env vars that tests might pollute."""
    keys = ["DATABASE_URL", "LITELLM_MASTER_KEY", "PROXY_PORT"]
    for k in keys:
        monkeypatch.delenv(k, raising=False)
    yield
