"""Toggle Claude Code between direct API and proxy."""

from __future__ import annotations

import json
import os
from pathlib import Path

from ..common.paths import PROJECT_DIR, PORT_FILE
from ..common.env import load_env, parse_env
from ..common.formatting import console, error


SETTINGS_FILE = Path.home() / ".claude" / "settings.json"


def cmd_toggle_claude() -> None:
    load_env()
    env = parse_env()

    master_key = env.get("LITELLM_MASTER_KEY", os.environ.get("LITELLM_MASTER_KEY", ""))
    if not master_key:
        error(f"LITELLM_MASTER_KEY not found in {PROJECT_DIR}/.env")
        return

    port = "4000"
    if PORT_FILE.exists():
        port = PORT_FILE.read_text().strip() or "4000"

    base_url = f"http://127.0.0.1:{port}"

    if not SETTINGS_FILE.exists():
        error(f"Claude settings not found at {SETTINGS_FILE}")
        return

    settings = json.loads(SETTINGS_FILE.read_text())
    current_base = settings.get("env", {}).get("ANTHROPIC_BASE_URL", "")

    if "127.0.0.1" in current_base:
        console.print("Switching Claude Code to use Direct Anthropic API (via OAuth)...")
        settings.pop("env", None)
        SETTINGS_FILE.write_text(json.dumps(settings, indent=2) + "\n")
        console.print("Claude Code now configured for Direct Anthropic API (OAuth).")
    else:
        console.print(f"Switching Claude Code to use LiteLLM Proxy (port {port})...")
        settings["env"] = {
            "ANTHROPIC_BASE_URL": base_url,
            "ANTHROPIC_AUTH_TOKEN": master_key,
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "ultra",
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "plus",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "lite",
        }
        SETTINGS_FILE.write_text(json.dumps(settings, indent=2) + "\n")
        console.print(f"Claude Code now configured for LiteLLM Proxy at {base_url}.")
        console.print("  Opus:  ultra")
        console.print("  Sonnet:   plus")
        console.print("  Haiku:   lite")

    console.print("Remember to restart Claude Code for changes to take full effect.")
