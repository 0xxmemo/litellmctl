"""Provider template loading and readiness checks."""

from __future__ import annotations

import json
import sys
from collections import OrderedDict
from pathlib import Path

import yaml

from ..common.paths import TEMPLATES_DIR, PROJECT_DIR, ENV_FILE
from ..common.formatting import TICK, CROSS, console
from ..common.network import http_check, transcr_http_check


def load_defaults() -> dict:
    path = TEMPLATES_DIR / "defaults.yaml"
    if not path.exists():
        console.print(f"[red]Missing {path}[/]")
        sys.exit(1)
    with open(path) as f:
        return yaml.safe_load(f)


def load_providers(load_order: list[str]) -> OrderedDict:
    providers: OrderedDict = OrderedDict()
    for pid in load_order:
        path = TEMPLATES_DIR / f"{pid}.yaml"
        if not path.exists():
            continue
        with open(path) as f:
            data = yaml.safe_load(f)
        data.setdefault("env_vars", [])
        data.setdefault("extra_models", [])
        data.setdefault("tiers", {})
        data.setdefault("auth", "none")
        data.setdefault("embedding_models", [])
        data.setdefault("transcription_models", [])
        providers[pid] = data
    for path in sorted(TEMPLATES_DIR.glob("*.yaml")):
        pid = path.stem
        if pid == "defaults" or pid in providers:
            continue
        with open(path) as f:
            data = yaml.safe_load(f)
        data.setdefault("env_vars", [])
        data.setdefault("extra_models", [])
        data.setdefault("tiers", {})
        data.setdefault("auth", "none")
        data.setdefault("embedding_models", [])
        data.setdefault("transcription_models", [])
        providers[pid] = data
    return providers


def env_var_set(env: dict, var_name: str) -> bool:
    val = env.get(var_name, "")
    if not val:
        return False
    placeholders = ("your-", "sk-ant-...", "change-me", "/path/to/", "")
    for p in placeholders:
        if val == p or val.startswith("your-"):
            return False
    return True


def auth_file_exists(env: dict, auth_info: dict) -> bool:
    filename = auth_info.get("file", "")
    if not filename:
        return False
    path = PROJECT_DIR / filename
    return path.exists() and path.stat().st_size > 10


def auth_file_valid(env: dict, auth_info: dict) -> bool:
    filename = auth_info.get("file", "")
    if not filename:
        return False
    path = PROJECT_DIR / filename
    if not path.exists():
        return False
    try:
        data = json.loads(path.read_text())
        return bool(data.get("access_token") or data.get("token"))
    except (json.JSONDecodeError, KeyError):
        return False


def check_local_servers(env: dict) -> tuple[bool, str]:
    embed_base = (
        env.get("LOCAL_EMBEDDING_API_BASE")
        or env.get("OLLAMA_API_BASE")
        or "http://localhost:11434"
    ).rstrip("/")
    transcr_base = (
        env.get("LOCAL_TRANSCRIPTION_API_BASE")
        or "http://localhost:10300/v1"
    ).rstrip("/")

    embed_up = http_check(f"{embed_base}/v1/models", timeout=2)
    transcr_up = transcr_http_check(transcr_base, timeout=2)

    if embed_up and transcr_up:
        return True, "both servers reachable"
    parts = []
    if not embed_up:
        parts.append(f"embedding offline ({embed_base})")
    if not transcr_up:
        parts.append(f"transcription offline ({transcr_base})")
    return False, "; ".join(parts) + " — run: litellmctl local setup"


def check_provider_ready(pid: str, prov: dict, env: dict,
                         auth_files: dict) -> tuple[bool, str]:
    auth_type = prov.get("auth", "none")
    if auth_type == "api_key":
        missing = [v for v in prov.get("env_vars", []) if not env_var_set(env, v)]
        if missing:
            return False, f"missing .env: {', '.join(missing)}"
        return True, "API key configured"
    elif auth_type == "oauth":
        af = auth_files.get(pid)
        if af and auth_file_exists(env, af):
            if auth_file_valid(env, af):
                return True, "OAuth token present"
            return False, "auth file exists but token looks invalid"
        return False, f"not authenticated — run: litellmctl auth {pid.replace('_', ' ').split()[0]}"
    has_embed = bool(prov.get("embedding_models"))
    has_transcr = bool(prov.get("transcription_models"))
    if has_embed or has_transcr:
        up, reason = check_local_servers(env)
        if up:
            return True, "local servers reachable"
        return False, reason
    return True, "no auth required"


def readiness_icon(ready: bool) -> str:
    return TICK if ready else CROSS
