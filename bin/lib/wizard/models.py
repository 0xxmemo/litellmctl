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


def collect_models(selected_providers: list[str], providers: OrderedDict,
                   tiers: list[str]) -> list[dict]:
    seen: set[str] = set()
    models: list[dict] = []
    for pid in selected_providers:
        prov = providers[pid]
        for tier in tiers:
            for m in prov["tiers"].get(tier, []):
                if m["model_name"] not in seen:
                    seen.add(m["model_name"])
                    models.append(model_entry(m))
        for m in prov.get("extra_models", []):
            if m["model_name"] not in seen:
                seen.add(m["model_name"])
                models.append(model_entry(m))
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


def build_aliases(tiers: list[str], primary_map: dict[str, str],
                  providers: OrderedDict) -> dict[str, str]:
    aliases = {}
    for tier in tiers:
        pid = primary_map.get(tier)
        if not pid or pid not in providers:
            continue
        tier_models = providers[pid]["tiers"].get(tier, [])
        if tier_models:
            aliases[tier] = tier_models[0]["model_name"]
    return aliases


def build_fallbacks(tiers: list[str], primary_map: dict[str, str],
                    fallback_map: dict[str, list[str]],
                    providers: OrderedDict) -> list[dict]:
    fallbacks: list[dict] = []
    for tier in tiers:
        primary_pid = primary_map.get(tier)
        if not primary_pid:
            continue
        chain: list[str] = []
        for fpid in fallback_map.get(tier, []):
            if fpid == primary_pid:
                continue
            fp = providers.get(fpid)
            if not fp:
                continue
            for m in fp["tiers"].get(tier, []):
                if m["model_name"] not in chain:
                    chain.append(m["model_name"])
        if chain:
            fallbacks.append({tier: chain})
    return fallbacks
