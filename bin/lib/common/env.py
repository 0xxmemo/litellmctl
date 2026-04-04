"""Environment file management — single source of truth."""

from __future__ import annotations

import os
from pathlib import Path

from .paths import PROJECT_DIR, ENV_FILE


def _strip_env_value_quotes(raw: str) -> str:
    """Drop one pair of surrounding quotes (.env style: KEY=\"value\")."""
    v = raw.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
        return v[1:-1]
    return v


def load_env() -> None:
    """Load .env into os.environ (skips already-set vars)."""
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = _strip_env_value_quotes(value)
        if key and key not in os.environ:
            os.environ[key] = value


def parse_env() -> dict[str, str]:
    """Parse .env into a dict, stripping surrounding quotes."""
    env: dict[str, str] = {}
    if not ENV_FILE.exists():
        return env
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = _strip_env_value_quotes(value)
    return env


def upsert_env_var(var: str, val: str, env_file: Path | None = None) -> bool:
    """Insert or update a single key=value in .env. Returns True if changed."""
    ef = env_file or ENV_FILE
    if not ef.exists():
        return False

    text = ef.read_text()
    lines = text.splitlines()

    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith(f"{var}="):
            old_val = stripped.split("=", 1)[1]
            if old_val == val:
                return False
            lines[i] = f"{var}={val}"
            ef.write_text("\n".join(lines) + "\n")
            return True

    # Not found — append
    with ef.open("a") as f:
        f.write(f"\n{var}={val}\n")
    return True


def patch_db_flags(env_file: Path | None = None) -> bool:
    """Write DB usage-collection env vars. Returns True if any changed."""
    ef = env_file or ENV_FILE
    dirty = False
    flags = {
        "LITELLM_LOCAL_MODEL_COST_MAP": "true",
        "DISABLE_SCHEMA_UPDATE": "true",
        "STORE_MODEL_IN_DB": "true",
        "PROXY_BATCH_WRITE_AT": "10",
        "STORE_PROMPTS_IN_SPEND_LOGS": "true",
    }
    text = ef.read_text() if ef.exists() else ""
    for var, val in flags.items():
        if f"\n{var}=" not in f"\n{text}" and not text.startswith(f"{var}="):
            with ef.open("a") as f:
                f.write(f"{var}={val}\n")
            dirty = True
            text = ef.read_text()
    return dirty


def patch_local_defaults(env_file: Path | None = None) -> bool:
    """Write LOCAL_EMBEDDING_API_BASE and LOCAL_TRANSCRIPTION_API_BASE defaults."""
    ef = env_file or ENV_FILE
    dirty = False
    defaults = {
        "LOCAL_EMBEDDING_API_BASE": "http://localhost:11434",
        "LOCAL_TRANSCRIPTION_API_BASE": "http://localhost:10300/v1",
    }
    text = ef.read_text() if ef.exists() else ""
    for var, val in defaults.items():
        if f"\n{var}=" not in f"\n{text}" and not text.startswith(f"{var}="):
            with ef.open("a") as f:
                f.write(f"{var}={val}\n")
            dirty = True
            text = ef.read_text()
    return dirty


def patch_perf_defaults(env_file: Path | None = None) -> bool:
    """Write proxy performance defaults (NUM_WORKERS, KEEPALIVE_TIMEOUT, etc.)."""
    ef = env_file or ENV_FILE
    dirty = False
    defaults = {
        "NUM_WORKERS": "4",
        "KEEPALIVE_TIMEOUT": "120",
        "AIOHTTP_CONNECTOR_LIMIT": "500",
        "AIOHTTP_CONNECTOR_LIMIT_PER_HOST": "100",
        "AIOHTTP_KEEPALIVE_TIMEOUT": "120",
        "AIOHTTP_TTL_DNS_CACHE": "600",
    }
    text = ef.read_text() if ef.exists() else ""
    for var, val in defaults.items():
        if f"\n{var}=" not in f"\n{text}" and not text.startswith(f"{var}="):
            with ef.open("a") as f:
                f.write(f"{var}={val}\n")
            dirty = True
            text = ef.read_text()
    return dirty


def remove_db_env_config(env_file: Path | None = None) -> None:
    """Remove DATABASE_URL and related DB flags from .env."""
    ef = env_file or ENV_FILE
    if not ef.exists():
        return
    remove_keys = {"DATABASE_URL", "DISABLE_SCHEMA_UPDATE", "STORE_MODEL_IN_DB",
                   "PROXY_BATCH_WRITE_AT", "STORE_PROMPTS_IN_SPEND_LOGS"}
    lines = ef.read_text().splitlines()
    filtered = [l for l in lines if not any(l.strip().startswith(f"{k}=") for k in remove_keys)]
    ef.write_text("\n".join(filtered) + "\n")
