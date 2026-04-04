"""Model collection and alias building."""

from __future__ import annotations

from collections import OrderedDict


def model_entry(m: dict) -> dict:
    entry: dict = {"model_name": m["model_name"]}
    if m.get("model_info"):
        entry["model_info"] = dict(m["model_info"])
    params: dict = {"model": m["model"]}
    if m.get("timeout"):
        params["timeout"] = m["timeout"]
    for key in ("api_key", "api_base"):
        if key in m:
            params[key] = m[key]
    if m.get("dimensions") is not None:
        params["dimensions"] = m["dimensions"]
    if "thinking" in m:
        params["thinking"] = dict(m["thinking"])
    entry["litellm_params"] = params
    return entry


def collect_models(selected_providers: list[str], providers: OrderedDict) -> list[dict]:
    """Collect all models from selected providers, dedup, sort alphanumerically."""
    seen: set[str] = set()
    models: list[dict] = []
    for pid in selected_providers:
        prov = providers[pid]
        for m in prov.get("models", []):
            if m["model_name"] not in seen:
                seen.add(m["model_name"])
                models.append(model_entry(m))
    models.sort(key=lambda e: e["model_name"])
    return models


def collect_task_models(selected_providers: list[str], providers: OrderedDict,
                        task_key: str) -> list[dict]:
    seen: set[str] = set()
    models: list[dict] = []
    for pid in selected_providers:
        prov = providers[pid]
        for m in prov.get(task_key, []):
            if m["model_name"] not in seen:
                seen.add(m["model_name"])
                models.append(model_entry(m))
    return models


def build_aliases(chain_sets: list[dict]) -> dict[str, str]:
    """Build model_group_alias from chain set definitions.

    Each chain set has: name, primary (model_name string).
    """
    aliases = {}
    for chain in chain_sets:
        name = chain["name"]
        primary = chain.get("primary")
        if primary:
            aliases[name] = primary
    return aliases


def build_fallbacks(chain_sets: list[dict]) -> list[dict]:
    """Build fallback list from chain set definitions.

    Each chain set has: name, fallbacks (list of model_name strings).
    """
    fallbacks: list[dict] = []
    for chain in chain_sets:
        name = chain["name"]
        fb_models = chain.get("fallbacks", [])
        if fb_models:
            fallbacks.append({name: fb_models})
    return fallbacks
