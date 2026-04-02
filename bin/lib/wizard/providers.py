"""Provider template loading and readiness checks."""

from __future__ import annotations

import json
import sys
from collections import OrderedDict
from pathlib import Path

import yaml

from ..common.paths import TEMPLATES_DIR, PROJECT_DIR, ENV_FILE
from ..common.formatting import TICK, CROSS, console
from ..common.network import ollama_server_check, transcr_http_check


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


def probe_local_services(env: dict) -> tuple[bool, bool, str, str]:
    """Return (embed_ok, transcr_ok, embed_base, transcr_base)."""
    embed_base = (
        env.get("LOCAL_EMBEDDING_API_BASE")
        or env.get("OLLAMA_API_BASE")
        or "http://localhost:11434"
    ).rstrip("/")
    transcr_base = (
        env.get("LOCAL_TRANSCRIPTION_API_BASE")
        or "http://localhost:10300/v1"
    ).rstrip("/")
    embed_ok = ollama_server_check(embed_base, timeout=2)
    transcr_ok = transcr_http_check(transcr_base, timeout=2)
    return embed_ok, transcr_ok, embed_base, transcr_base


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
        embed_ok, transcr_ok, embed_base, transcr_base = probe_local_services(env)
        # Allow wizard to proceed if any configured local service is up (common: Ollama only).
        if has_embed and has_transcr:
            if embed_ok and transcr_ok:
                return True, "Ollama and transcription reachable"
            if embed_ok:
                return True, (
                    f"Ollama OK ({embed_base}); transcription offline ({transcr_base}) "
                    "— embeddings will work; run litellmctl local setup for whisper"
                )
            if transcr_ok:
                return True, (
                    f"transcription OK ({transcr_base}); Ollama offline ({embed_base}) "
                    "— start Ollama for local embeddings"
                )
            if prov.get("role") == "supplemental":
                return True, (
                    "local servers not detected — Ollama/transcription entries will still be written; "
                    "set LOCAL_EMBEDDING_API_BASE / LOCAL_TRANSCRIPTION_API_BASE and run litellmctl local setup"
                )
            return False, (
                f"Ollama ({embed_base}) and transcription ({transcr_base}) offline "
                "— run: litellmctl local setup"
            )
        if has_embed:
            if embed_ok:
                return True, f"Ollama reachable ({embed_base})"
            if prov.get("role") == "supplemental":
                return True, (
                    f"Ollama not detected ({embed_base}) — embedding entries will still be written; "
                    "start Ollama before calling the API"
                )
            return False, f"Ollama offline ({embed_base}) — run: litellmctl local setup"
        if has_transcr:
            if transcr_ok:
                return True, f"transcription reachable ({transcr_base})"
            if prov.get("role") == "supplemental":
                return True, (
                    f"transcription not detected ({transcr_base}) — transcription entries will still be written; "
                    "start faster-whisper-server before calling the API"
                )
            return False, (
                f"transcription offline ({transcr_base}) — run: litellmctl local setup"
            )
    return True, "no auth required"


def readiness_icon(ready: bool) -> str:
    return TICK if ready else CROSS
