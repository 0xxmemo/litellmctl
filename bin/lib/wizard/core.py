"""Main wizard flow."""

from __future__ import annotations

import shutil
import subprocess

from ..common.paths import PROJECT_DIR, CONFIG_FILE, ENV_FILE, ENV_EXAMPLE
from ..common.env import parse_env
from ..common.formatting import console, header, step, dim, TICK, CROSS, WARN_SYM, ARROW
from ..common.platform import detect_os
from ..common.prompts import (
    confirm, pick_many, pick_ordered, ask, select, choice, separator,
)

from .providers import (
    load_defaults, load_providers, check_provider_ready,
    readiness_icon, env_var_set, auth_file_exists,
)
from .models import collect_models, collect_task_models, collect_search_models, build_aliases, build_fallbacks
from .config_gen import generate_yaml


def _all_models_for_display(selected_pids: list[str], providers: dict) -> list[tuple[str, str, dict]]:
    """Return (provider_name, model_name, model_dict) sorted by model_name.

    Used to present models to the user during chain set configuration.
    """
    result: list[tuple[str, str, dict]] = []
    seen: set[str] = set()
    for pid in selected_pids:
        prov = providers[pid]
        for m in prov.get("models", []):
            if m["model_name"] not in seen:
                seen.add(m["model_name"])
                result.append((prov.get("name", pid), m["model_name"], m))
    result.sort(key=lambda x: x[1])
    return result


def _configure_chain_set_interactive(
    set_names: list[str],
    selected_pids: list[str],
    providers: dict,
) -> list[dict]:
    """Interactively configure a chain set (group of 3 chains).

    Returns list of chain dicts: [{name, primary, fallbacks}, ...]
    """
    all_models = _all_models_for_display(selected_pids, providers)
    chain_set: list[dict] = []

    for chain_name in set_names:
        console.print(f"\n  [bold]{chain_name}[/]:")

        # Build model choice list grouped by provider with separators
        model_choices = []   # questionary Choice objects
        model_names: list[str] = []
        current_provider = ""
        for prov_name, model_name, _m in all_models:
            if prov_name != current_provider:
                current_provider = prov_name
                model_choices.append(separator(f"── {prov_name} ──"))
            model_choices.append(choice(model_name, value=model_name))
            model_names.append(model_name)

        # Pick primary
        console.print(f"    {dim('Select the primary model (alias target):')}")
        result = select(f"  Primary for {chain_name}:", model_choices)
        if result is None:
            raise KeyboardInterrupt
        primary_model = result
        console.print(f"    {TICK} primary: [green]{primary_model}[/]")

        # Pick fallbacks (excluding primary)
        fb_choices: list[str] = []
        for mname in model_names:
            if mname != primary_model:
                fb_choices.append(mname)

        if fb_choices:
            console.print(f"    {dim('Select fallback models (spacebar to toggle, Enter when done):')}")
            fb_order = pick_ordered(f"  Fallbacks for {chain_name}:", fb_choices)
            fallbacks = [fb_choices[i] for i in fb_order] if fb_order else []
        else:
            fallbacks = []

        if fallbacks:
            console.print(f"    {TICK} fallbacks: {' → '.join(fallbacks)}")
        else:
            console.print(f"    {dim('no fallbacks')}")

        chain_set.append({
            "name": chain_name,
            "primary": primary_model,
            "fallbacks": fallbacks,
        })

    return chain_set


def run_wizard() -> bool:
    """Run the wizard. Returns True on success, False on failure/cancel."""
    defaults = load_defaults()
    auth_files_conf = defaults.get("auth_files", {})

    providers = load_providers()
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

    # ── Step 1: Environment scan ─────────────────────────────────────────────
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

        model_count = len(prov.get("models", []))
        model_hint = f"{model_count} model{'s' if model_count != 1 else ''}"
        console.print(f"  {icon} {name:<28} {auth_label:<10} {dim(model_hint)}  {dim(reason)}")

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

        if len(ready_pids) == 0:
            console.print(f"\n  [red]No providers are ready.[/] Set up API keys in .env or run auth commands first.")
            console.print("  See .env.example for guidance, or run: litellmctl auth status")
            return False
        else:
            console.print(f"\n  {dim(f'Proceeding with {len(ready_pids)} ready provider(s).')}")

    # ── Step 2: Select providers ─────────────────────────────────────────────
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

    # ── Step 3: Configure fallback chain sets ────────────────────────────────
    step(3, "Configure fallback chains")
    console.print(f"  {dim('Chains come in groups of 3 (high / mid / low capability).')}")
    console.print(f"  {dim('For each chain you pick a primary model and optional fallbacks.')}")

    chain_sets: list[dict] = []
    set_num = 1

    while True:
        if set_num == 1:
            default_names_str = "ultra,plus,lite"
        else:
            default_names_str = f"set{set_num}-high,set{set_num}-mid,set{set_num}-low"

        console.print(f"\n  {dim(f'Chain set #{set_num} — enter 3 names, comma-separated.')}")
        names_input = ask(f"  Chain names:", default=default_names_str)
        names = [n.strip() for n in names_input.split(",") if n.strip()]
        if len(names) != 3:
            console.print(f"  {WARN_SYM} Need exactly 3 names (got {len(names)}). Try again.")
            continue

        existing_names = {cs["name"] for cs in chain_sets}
        dupes = [n for n in names if n in existing_names]
        if dupes:
            console.print(f"  {WARN_SYM} Name(s) already in use: {', '.join(dupes)}. Try again.")
            continue

        new_chains = _configure_chain_set_interactive(names, selected_pids, providers)
        chain_sets.extend(new_chains)
        set_num += 1

        if not confirm("  Add another chain set?", default=False):
            break

    if not chain_sets:
        console.print(f"\n  [red]No chains configured.[/] Aborting.")
        return False

    # ── Step 3.5: Web search integration ────────────────────────────────────
    search_models: list[dict] = []
    has_search_provider = any(
        providers[pid].get("search_models")
        for pid in selected_pids
    )
    if has_search_provider:
        from .providers import probe_local_services
        _, _, searxng_ok, _, _, searxng_base = probe_local_services(env)
        if searxng_ok:
            console.print(f"\n[bold]Web search integration[/]")
            console.print(f"  {TICK} SearXNG detected at [green]{searxng_base}[/]")
            console.print(f"  {dim('Claude Code web searches will be routed through SearXNG via the proxy.')}")
            if confirm("  Enable web search interception?"):
                search_models = collect_search_models(selected_pids, providers)
                console.print(f"  {TICK} Web search interception enabled")
            else:
                console.print(f"  {dim('Skipped.')}")
        else:
            console.print(f"\n  {dim('SearXNG not running — web search interception skipped.')}")
            console.print(f"  {dim('Install with: litellmctl install --with-searxng')}")

    # ── Step 4: Generate ─────────────────────────────────────────────────────
    step(4, "Generate config")

    all_selected = list(dict.fromkeys(selected_pids))
    models = collect_models(all_selected, providers)
    aliases = build_aliases(chain_sets)
    fallbacks = build_fallbacks(chain_sets)
    embedding_models = collect_task_models(all_selected, providers, "embedding_models")
    transcription_models = collect_task_models(all_selected, providers, "transcription_models")
    image_models = collect_task_models(all_selected, providers, "image_models")
    yaml_content = generate_yaml(models, aliases, fallbacks, defaults,
                                 embedding_models=embedding_models or None,
                                 transcription_models=transcription_models or None,
                                 image_models=image_models or None,
                                 search_models=search_models or None)

    # Summary
    header("Summary")

    for cs in chain_sets:
        console.print(f"  [bold]{cs['name']}[/]: [green]{cs['primary']}[/]")
        if cs["fallbacks"]:
            console.print(f"    fallbacks: {' → '.join(cs['fallbacks'])}")

    console.print(f"\n  Models: {len(models)} total  |  Chains: {len(chain_sets)}")
    console.print(f"  Providers: {', '.join(providers[p]['name'] for p in all_selected)}")
    if embedding_models:
        console.print(f"  {dim(f'Local embedding deployments: {len(embedding_models)}')}")
    if transcription_models:
        console.print(f"  {dim(f'Local transcription deployments: {len(transcription_models)}')}")
    if image_models:
        console.print(f"  {dim(f'Image generation models: {len(image_models)}')}")
    if search_models:
        console.print(f"  {TICK} Web search: SearXNG (websearch interception enabled)")

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
