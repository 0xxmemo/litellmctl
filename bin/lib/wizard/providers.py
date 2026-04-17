"""Provider template loading and readiness checks."""

from __future__ import annotations

import json
import sys
from collections import OrderedDict
from pathlib import Path

import yaml

from ..common.paths import TEMPLATES_DIR, PROJECT_DIR, ENV_FILE
from ..common.formatting import TICK, CROSS, console
from ..common.network import ollama_server_check, transcr_http_check, searxng_http_check


def load_defaults() -> dict:
    path = TEMPLATES_DIR / "defaults.yaml"
    if not path.exists():
        console.print(f"[red]Missing {path}[/]")
        sys.exit(1)
    with open(path) as f:
        return yaml.safe_load(f)


def _flatten_tiers(data: dict) -> None:
    """Backward compat: convert old tiers + extra_models format to flat models list."""
    tiers = data.pop("tiers", {})
    extra = data.pop("extra_models", [])
    if not tiers and not extra:
        return
    seen: set[str] = set()
    models: list[dict] = data.get("models", [])
    # Collect existing model_names to avoid dupes
    for m in models:
        seen.add(m["model_name"])
    # Flatten tiers (sorted by tier name for determinism)
    for _tier_name in sorted(tiers.keys()):
        for m in tiers[_tier_name]:
            if m["model_name"] not in seen:
                seen.add(m["model_name"])
                models.append(m)
    # Append extra models
    for m in extra:
        if m["model_name"] not in seen:
            seen.add(m["model_name"])
            models.append(m)
    # Sort by model_name
    models.sort(key=lambda m: m["model_name"])
    data["models"] = models


def _normalize_provider(data: dict) -> None:
    """Ensure all expected keys exist on a provider dict."""
    # Backward compat: flatten old tiers format
    if "tiers" in data or "extra_models" in data:
        _flatten_tiers(data)
    data.setdefault("models", [])
    data.setdefault("env_vars", [])
    data.setdefault("auth", "none")
    data.setdefault("embedding_models", [])
    data.setdefault("transcription_models", [])
    data.setdefault("search_models", [])
    # Sort models by model_name
    data["models"].sort(key=lambda m: m["model_name"])


def load_providers() -> OrderedDict:
    """Load all provider templates in alphanumeric order."""
    providers: OrderedDict = OrderedDict()
    for path in sorted(TEMPLATES_DIR.glob("*.yaml")):
        pid = path.stem
        if pid == "defaults":
            continue
        with open(path) as f:
            data = yaml.safe_load(f)
        _normalize_provider(data)
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


def probe_local_services(env: dict) -> tuple[bool, bool, bool, str, str, str]:
    """Return (embed_ok, transcr_ok, searxng_ok, embed_base, transcr_base, searxng_base)."""
    embed_base = (
        env.get("LOCAL_EMBEDDING_API_BASE")
        or env.get("OLLAMA_API_BASE")
        or "http://localhost:11434"
    ).rstrip("/")
    transcr_base = (
        env.get("LOCAL_TRANSCRIPTION_API_BASE")
        or "http://localhost:10300/v1"
    ).rstrip("/")
    searxng_port = env.get("SEARXNG_PORT", "8888")
    searxng_base = f"http://localhost:{searxng_port}"
    embed_ok = ollama_server_check(embed_base, timeout=2)
    transcr_ok = transcr_http_check(transcr_base, timeout=2)
    searxng_ok = searxng_http_check(searxng_base, timeout=2)
    return embed_ok, transcr_ok, searxng_ok, embed_base, transcr_base, searxng_base


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
    has_search = bool(prov.get("search_models"))
    if has_embed or has_transcr or has_search:
        embed_ok, transcr_ok, searxng_ok, embed_base, transcr_base, searxng_base = probe_local_services(env)

        # Build SearXNG status suffix for the reason string
        search_hint = ""
        if has_search:
            if searxng_ok:
                search_hint = f"; SearXNG OK ({searxng_base})"
            else:
                search_hint = f"; SearXNG offline — install: litellmctl install --with-searxng"

        # Allow wizard to proceed if any configured local service is up (common: Ollama only).
        if has_embed and has_transcr:
            if embed_ok and transcr_ok:
                return True, "Ollama and transcription reachable" + search_hint
            if embed_ok:
                return True, (
                    f"Ollama OK ({embed_base}); transcription offline ({transcr_base}) "
                    "— embeddings will work; run litellmctl install --with-transcription for speaches"
                ) + search_hint
            if transcr_ok:
                return True, (
                    f"transcription OK ({transcr_base}); Ollama offline ({embed_base}) "
                    "— start Ollama for local embeddings"
                ) + search_hint
            if prov.get("role") == "supplemental":
                return True, (
                    "local servers not detected — Ollama/transcription entries will still be written; "
                    "set LOCAL_EMBEDDING_API_BASE / LOCAL_TRANSCRIPTION_API_BASE and run litellmctl local setup"
                ) + search_hint
            return False, (
                f"Ollama ({embed_base}) and transcription ({transcr_base}) offline "
                "— run: litellmctl local setup"
            )
        if has_embed:
            if embed_ok:
                return True, f"Ollama reachable ({embed_base})" + search_hint
            if prov.get("role") == "supplemental":
                return True, (
                    f"Ollama not detected ({embed_base}) — embedding entries will still be written; "
                    "start Ollama before calling the API"
                ) + search_hint
            return False, f"Ollama offline ({embed_base}) — run: litellmctl local setup"
        if has_transcr:
            if transcr_ok:
                return True, f"transcription reachable ({transcr_base})" + search_hint
            if prov.get("role") == "supplemental":
                return True, (
                    f"transcription not detected ({transcr_base}) — transcription entries will still be written; "
                    "start speaches before calling the API"
                ) + search_hint
            return False, (
                f"transcription offline ({transcr_base}) — run: litellmctl local setup"
            )
        # Only search_models, no embed/transcr
        if has_search:
            if prov.get("role") == "supplemental":
                reason = "SearXNG OK" if searxng_ok else "SearXNG offline — install: litellmctl install --with-searxng"
                return True, reason
    return True, "no auth required"


def readiness_icon(ready: bool) -> str:
    return TICK if ready else CROSS
