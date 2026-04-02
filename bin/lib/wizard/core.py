"""Main wizard flow."""

from __future__ import annotations

import shutil
import subprocess

from ..common.paths import PROJECT_DIR, CONFIG_FILE, ENV_FILE, ENV_EXAMPLE
from ..common.env import parse_env
from ..common.formatting import console, header, step, dim, TICK, CROSS, WARN_SYM, ARROW
from ..common.platform import detect_os
from ..common.prompts import pick_ordered

from .providers import (
    load_defaults, load_providers, check_provider_ready,
    readiness_icon, env_var_set, auth_file_exists,
)
from .models import collect_models, collect_task_models, build_aliases, build_fallbacks
from .config_gen import generate_yaml
from ..common.prompts import confirm, pick_one, pick_many


def run_wizard() -> bool:
    """Run the wizard. Returns True on success, False on failure/cancel."""
    defaults = load_defaults()
    tiers = defaults.get("tiers", ["ultra", "plus", "lite"])
    load_order = defaults.get("load_order", [])
    auth_files_conf = defaults.get("auth_files", {})
    default_primary = defaults.get("primary", {})
    default_fallback = defaults.get("fallback_order", {})

    providers = load_providers(load_order)
    if not providers:
        console.print("[red]No provider templates found in templates/[/]")
        return False

    env = parse_env()

    # Banner
    console.print()
    console.print("[bold]  litellmctl config wizard[/]")
    console.print(f"  {dim('─' * 40)}")
    console.print(f"  OS: {detect_os()}  |  Project: {PROJECT_DIR}")
    console.print()

    # Step 1: Environment scan
    step(1, "Environment & provider readiness")

    if not ENV_FILE.exists():
        console.print(f"  {CROSS} No .env file found.")
        if ENV_EXAMPLE.exists():
            if confirm("     Copy .env.example to .env?"):
                shutil.copy2(ENV_EXAMPLE, ENV_FILE)
                console.print(f"     {TICK} Created .env from template")
                env = parse_env()
            else:
                console.print(f"     {WARN_SYM} Continuing without .env — some providers will be unavailable")
        else:
            console.print(f"     {WARN_SYM} No .env or .env.example found. Create .env manually.")
    else:
        console.print(f"  {TICK} .env found ({sum(1 for v in env.values() if v)} variables)")

    if env_var_set(env, "LITELLM_MASTER_KEY"):
        console.print(f"  {TICK} LITELLM_MASTER_KEY is set")
    else:
        console.print(f"  {WARN_SYM} LITELLM_MASTER_KEY not set — proxy won't accept requests")
        console.print("     Add to .env:  LITELLM_MASTER_KEY=sk-litellm-<your-key>")

    console.print()
    provider_status: dict[str, tuple[bool, str]] = {}
    ready_pids: list[str] = []
    not_ready_pids: list[str] = []

    for pid, prov in providers.items():
        ready, reason = check_provider_ready(pid, prov, env, auth_files_conf)
        provider_status[pid] = (ready, reason)
        icon = readiness_icon(ready)
        auth_type = prov.get("auth", "none")
        auth_label = {"api_key": "API key", "oauth": "OAuth"}.get(auth_type, "none")
        name = prov.get("name", pid)

        tier_list = ", ".join(t for t in tiers if t in prov.get("tiers", {}))
        console.print(f"  {icon} {name:<28} {auth_label:<10} {dim(reason)}")
        if tier_list:
            console.print(f"    {dim('Tiers: ' + tier_list)}")

        if ready:
            ready_pids.append(pid)
        else:
            not_ready_pids.append(pid)

    if not ready_pids:
        console.print(f"\n  [red]No providers are ready.[/] Set up API keys in .env or run auth commands first.")
        console.print("  See .env.example for guidance, or run: litellmctl auth status")
        return False

    if not_ready_pids:
        console.print(f"\n  {dim(f'{len(not_ready_pids)} provider(s) need setup.')}")
        for pid in not_ready_pids:
            prov = providers[pid]
            auth_type = prov.get("auth", "none")
            if auth_type == "oauth":
                cmd = prov.get("auth_cmd", f"litellmctl auth {pid}")
                console.print(f"    {ARROW} {prov['name']}: run  [bold]{cmd}[/]")
            elif auth_type == "api_key":
                vars_needed = prov.get("env_vars", [])
                console.print(f"    {ARROW} {prov['name']}: add to .env  [bold]{', '.join(vars_needed)}[/]")
            elif auth_type == "none" and (prov.get("embedding_models") or prov.get("transcription_models")):
                console.print(f"    {ARROW} {prov['name']}: start local inference servers")
                console.print(f"         run  [bold]litellmctl local setup[/]")

        # Only prompt if ALL providers are unready; otherwise proceed with ready ones
        if len(ready_pids) == 0:
            console.print(f"\n  [red]No providers are ready.[/] Set up API keys in .env or run auth commands first.")
            console.print("  See .env.example for guidance, or run: litellmctl auth status")
            return False
        else:
            console.print(f"\n  {dim(f'Proceeding with {len(ready_pids)} ready provider(s).')}")

    # Step 2: Select providers
    step(2, "Select providers to include")

    available = [(pid, providers[pid]) for pid in ready_pids if pid in providers]
    provider_choices = [
        f"{prov['name']:<28} {prov.get('desc', '')}"
        for _, prov in available
    ]
    sel_idx = pick_many("Select providers:", provider_choices)
    if not sel_idx:
        sel_idx = list(range(len(available)))
    selected_pids = [available[i][0] for i in sel_idx]
    selected_names = [providers[pid]["name"] for pid in selected_pids]
    console.print(f"  {ARROW} [green]{', '.join(selected_names)}[/]")

    # Step 3: Per-tier primary provider
    step(3, "Choose primary provider for each tier")
    console.print(f"  {dim('The primary is the main model behind the serving alias.')}")
    console.print(f"  {dim('Others become fallbacks, tried in order on failure.')}")

    primary_map: dict[str, str] = {}

    for tier in tiers:
        candidates = [
            pid for pid in selected_pids
            if tier in providers[pid].get("tiers", {})
        ]
        if not candidates:
            console.print(f"\n  [yellow]{tier}[/]: no providers have this tier — skipping")
            continue

        dp = default_primary.get(tier)
        default_choice = None

        choices = []
        for pid in candidates:
            m = providers[pid]["tiers"][tier][0]
            marker = " (current)" if pid == dp else ""
            choices.append(f"{providers[pid]['name']:<24} {ARROW} {m['model_name']}{marker}")
            if pid == dp:
                default_choice = choices[-1]

        if len(candidates) == 1:
            choice_idx = 0
            console.print(f"\n  [bold]{tier}[/]: {dim('(only one option)')}")
        else:
            console.print(f"\n  [bold]{tier}[/]:")
            choice_idx = pick_one(f"Primary for {tier}:", choices, default=default_choice)

        primary_map[tier] = candidates[choice_idx]
        prim_model = providers[candidates[choice_idx]]["tiers"][tier][0]["model_name"]
        console.print(f"    {TICK} {tier} {ARROW} [green]{prim_model}[/]")

    active_tiers = [t for t in tiers if t in primary_map]

    # Step 4: Fallback ordering
    step(4, "Fallback order per tier")
    console.print(f"  {dim('Reorder fallback providers, or press Enter for defaults.')}")

    fallback_map: dict[str, list[str]] = {}

    for tier in active_tiers:
        primary_pid = primary_map[tier]
        default_order = default_fallback.get(tier, [])
        candidates = []
        for pid in default_order:
            if (pid in selected_pids and pid != primary_pid
                    and tier in providers[pid].get("tiers", {})):
                candidates.append(pid)
        for pid in selected_pids:
            if (pid not in candidates and pid != primary_pid
                    and tier in providers[pid].get("tiers", {})):
                candidates.append(pid)

        if not candidates:
            console.print(f"\n  [bold]{tier}[/]: {dim('no fallback providers')}")
            fallback_map[tier] = []
            continue

        console.print(f"\n  [bold]{tier}[/] (primary: {providers[primary_pid]['name']}):")
        fb_choices = []
        for pid in candidates:
            m = providers[pid]["tiers"][tier][0]
            fb_choices.append(f"{providers[pid]['name']:<24} {ARROW} {m['model_name']}")

        selected_fb = pick_ordered(f"Fallback order for {tier}:", fb_choices)
        fallback_map[tier] = [candidates[i] for i in selected_fb] if selected_fb else candidates

    # Step 5: Generate
    step(5, "Generate config")

    all_selected = list(dict.fromkeys(
        [primary_map[t] for t in active_tiers] + selected_pids
    ))
    models = collect_models(all_selected, providers, tiers)
    aliases = build_aliases(active_tiers, primary_map, providers)
    fallbacks = build_fallbacks(active_tiers, primary_map, fallback_map, providers)
    embedding_models = collect_task_models(all_selected, providers, "embedding_models")
    transcription_models = collect_task_models(all_selected, providers, "transcription_models")
    yaml_content = generate_yaml(models, aliases, fallbacks, defaults,
                                 embedding_models=embedding_models or None,
                                 transcription_models=transcription_models or None)

    # Summary
    header("Summary")

    for tier in active_tiers:
        ppid = primary_map[tier]
        pmodel = providers[ppid]["tiers"][tier][0]["model_name"]
        fb_pids = fallback_map.get(tier, [])
        fb_models = []
        for fpid in fb_pids:
            for m in providers[fpid]["tiers"].get(tier, []):
                fb_models.append(m["model_name"])
        console.print(f"  [bold]{tier}[/]: [green]{pmodel}[/]")
        if fb_models:
            console.print(f"    fallbacks: {' → '.join(fb_models)}")

    console.print(f"\n  Models: {len(models)} total  |  Tiers: {', '.join(active_tiers)}")
    console.print(f"  Providers: {', '.join(providers[p]['name'] for p in all_selected)}")
    if embedding_models:
        console.print(f"  {dim(f'Local embedding deployments: {len(embedding_models)}')}")
    if transcription_models:
        console.print(f"  {dim(f'Local transcription deployments: {len(transcription_models)}')}")

    env_vars_needed: list[str] = []
    auth_cmds_needed: list[str] = []
    for pid in all_selected:
        p = providers[pid]
        for v in p.get("env_vars", []):
            if v not in env_vars_needed:
                env_vars_needed.append(v)
        if p.get("auth_cmd") and p["auth_cmd"] not in auth_cmds_needed:
            auth_cmds_needed.append(p["auth_cmd"])
    if "LITELLM_MASTER_KEY" not in env_vars_needed:
        env_vars_needed.append("LITELLM_MASTER_KEY")

    missing_env = [v for v in env_vars_needed if not env_var_set(env, v)]
    if missing_env:
        console.print(f"\n  {WARN_SYM} Missing .env vars: [yellow]{', '.join(missing_env)}[/]")
        console.print(f"     Edit {ENV_FILE} and add these before starting the proxy.")
    if auth_cmds_needed:
        not_authed = [
            cmd for cmd in auth_cmds_needed
            if not any(
                auth_file_exists(env, auth_files_conf.get(pid, {}))
                for pid in all_selected
                if providers[pid].get("auth_cmd") == cmd
            )
        ]
        if not_authed:
            console.print(f"\n  {WARN_SYM} Run these auth commands:")
            for cmd in not_authed:
                console.print(f"     [bold]{cmd}[/]")

    console.print()

    if not confirm("  Write config.yaml?"):
        console.print("  [yellow]Aborted.[/]")
        return False

    if CONFIG_FILE.exists():
        backup = CONFIG_FILE.with_suffix(".yaml.bak")
        shutil.copy2(CONFIG_FILE, backup)
        console.print(f"  {dim(f'Backed up → {backup.name}')}")

    CONFIG_FILE.write_text(yaml_content)
    console.print(f"  {TICK} Written to {CONFIG_FILE}")

    proxy_running = False
    try:
        port_file = PROJECT_DIR / ".proxy-port"
        if port_file.exists():
            port = int(port_file.read_text().strip())
            import socket
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(1)
                proxy_running = s.connect_ex(("127.0.0.1", port)) == 0
    except Exception:
        pass

    if proxy_running:
        if confirm("\n  Proxy is running. Restart now?"):
            ctl = PROJECT_DIR / "bin" / "litellmctl"
            try:
                subprocess.run([str(ctl), "restart", "proxy"], check=True)
            except (subprocess.CalledProcessError, FileNotFoundError):
                console.print(f"  {WARN_SYM} Auto-restart failed. Run manually: litellmctl restart proxy")
        else:
            console.print(f"  {dim('Run litellmctl restart proxy when ready.')}")
    else:
        console.print(f"  {dim('Start the proxy with: litellmctl start')}")

    console.print()
    return True
