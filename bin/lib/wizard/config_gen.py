"""YAML config generation."""

from __future__ import annotations


def write_model_entries(lines: list[str], models: list[dict]) -> None:
    current_prefix = None
    for entry in models:
        prefix = entry["model_name"].split("/")[0] if "/" in entry["model_name"] else ""
        if prefix != current_prefix:
            if current_prefix is not None:
                lines.append("")
            current_prefix = prefix
        lines.append(f"  - model_name: {entry['model_name']}")
        if "model_info" in entry:
            lines.append("    model_info:")
            for k, v in entry["model_info"].items():
                lines.append(f"      {k}: {v}")
        lines.append("    litellm_params:")
        params = entry["litellm_params"]
        for k, v in params.items():
            if isinstance(v, dict):
                lines.append(f"      {k}:")
                for sk, sv in v.items():
                    lines.append(f"        {sk}: {sv}")
            else:
                lines.append(f"      {k}: {v}")


def generate_yaml(models: list[dict], aliases: dict[str, str],
                  fallbacks: list[dict], defaults: dict,
                  embedding_models: list[dict] | None = None,
                  transcription_models: list[dict] | None = None,
                  search_models: list[dict] | None = None) -> str:
    lines: list[str] = ["model_list:"]
    write_model_entries(lines, models)

    if embedding_models:
        lines.append("")
        lines.append("  # ── Local embedding models ──────────────────────────────────────────────")
        lines.append("  # Base URL: LOCAL_EMBEDDING_API_BASE env var  (default: http://localhost:11434)")
        ollama_tags: list[str] = []
        for em in embedding_models:
            raw = (em.get("litellm_params") or {}).get("model")
            if isinstance(raw, str) and raw.startswith("ollama/"):
                tag = raw.split("/", 1)[1]
                if tag not in ollama_tags:
                    ollama_tags.append(tag)
        if ollama_tags:
            pull = " && ollama pull ".join(ollama_tags)
            lines.append(f"  # ollama pull {pull}")
        write_model_entries(lines, embedding_models)

    if transcription_models:
        lines.append("")
        lines.append("  # ── Local transcription models ──────────────────────────────────────────")
        lines.append("  # Base URL: LOCAL_TRANSCRIPTION_API_BASE env var  (default: http://localhost:10300/v1)")
        write_model_entries(lines, transcription_models)

    if search_models:
        lines.append("")
        lines.append("# ── Web search tools (websearch interception) ─────────────────────────────")
        lines.append("# Claude Code web searches are transparently routed through SearXNG.")
        lines.append("search_tools:")
        for sm in search_models:
            lines.append(f'  - search_tool_name: "{sm["search_tool_name"]}"')
            lines.append("    litellm_params:")
            lines.append(f'      search_provider: "{sm["search_provider"]}"')
            if "api_base" in sm:
                lines.append(f'      api_base: "{sm["api_base"]}"')

    rs = defaults.get("router_settings", {})
    lines.append("")
    lines.append("router_settings:")
    for k, v in rs.items():
        lines.append(f"  {k}: {v}")

    if aliases:
        lines.append("  model_group_alias:")
        for alias, target in aliases.items():
            lines.append(f"    {alias}: {target}")

    if fallbacks:
        lines.append("  fallbacks:")
        for fb in fallbacks:
            for tier_name, chain in fb.items():
                lines.append(f"    - {tier_name}:")
                lines.append("        [")
                for m in chain:
                    lines.append(f"          {m},")
                lines.append("        ]")

    ls = dict(defaults.get("litellm_settings", {}))

    # Inject websearch_interception if search is enabled
    if search_models:
        success_cb = list(ls.get("success_callback", []))
        if "websearch_interception" not in success_cb:
            success_cb.append("websearch_interception")
        ls["success_callback"] = success_cb

        # Extract unique LiteLLM provider names from model list
        # (provider is the prefix before "/" in litellm_params.model)
        providers_set: set[str] = set()
        for m in models:
            lp_model = (m.get("litellm_params") or {}).get("model", "")
            if "/" in lp_model:
                providers_set.add(lp_model.split("/", 1)[0])
        if embedding_models:
            for m in embedding_models:
                lp_model = (m.get("litellm_params") or {}).get("model", "")
                if "/" in lp_model:
                    providers_set.add(lp_model.split("/", 1)[0])

        params: dict = {
            "search_tool_name": search_models[0]["search_tool_name"],
        }
        if providers_set:
            params["enabled_providers"] = sorted(providers_set)
        ls["websearch_interception_params"] = params

    lines.append("")
    lines.append("litellm_settings:")
    for k, v in ls.items():
        if isinstance(v, dict):
            lines.append(f"  {k}:")
            for sk, sv in v.items():
                if isinstance(sv, str):
                    lines.append(f'    {sk}: "{sv}"')
                elif isinstance(sv, list):
                    lines.append(f"    {sk}:")
                    for item in sv:
                        lines.append(f"      - {item}")
                else:
                    lines.append(f"    {sk}: {sv}")
        elif isinstance(v, bool):
            lines.append(f"  {k}: {'true' if v else 'false'}")
        elif isinstance(v, list):
            lines.append(f"  {k}:")
            for item in v:
                lines.append(f"    - {item}")
        else:
            lines.append(f"  {k}: {v}")

    gs = defaults.get("general_settings", {})
    lines.append("")
    lines.append("general_settings:")
    for k, v in gs.items():
        lines.append(f"  {k}: {v}")

    lines.append("")
    lines.append("environment_variables:")
    lines.append("  # Token dirs & auth files are set in .env (machine-specific paths)")
    lines.append("")

    return "\n".join(lines)
