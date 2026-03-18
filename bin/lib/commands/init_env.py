"""Auth file detection and .env sync."""

from __future__ import annotations

from ..common.paths import PROJECT_DIR, ENV_FILE
from ..common.env import upsert_env_var
from ..common.formatting import console, info, warn


def cmd_init_env() -> None:
    if not ENV_FILE.exists():
        warn("No .env file found. Copy .env.example first:")
        warn(f"  cp {PROJECT_DIR}/.env.example {ENV_FILE}")
        return

    changed = False

    def process_auth(auth_file: str, dir_var: str, file_var: str) -> None:
        nonlocal changed
        path = PROJECT_DIR / auth_file
        if path.exists():
            c1 = upsert_env_var(dir_var, str(PROJECT_DIR))
            c2 = upsert_env_var(file_var, auth_file)
            if c1 or c2:
                changed = True
                console.print(f"  [green]\u2713[/] {auth_file:<30} synced")
            else:
                console.print(f"  [green]\u2713[/] {auth_file:<30} (up to date)")
        else:
            console.print(f"  [yellow]-[/] {auth_file:<30} (not found, skipped)")

    info(f"Scanning {PROJECT_DIR} for auth files ...")
    process_auth("auth.chatgpt.json", "CHATGPT_TOKEN_DIR", "CHATGPT_AUTH_FILE")
    process_auth("auth.gemini_cli.json", "GEMINI_CLI_TOKEN_DIR", "GEMINI_CLI_AUTH_FILE")
    process_auth("auth.qwen_portal.json", "QWEN_PORTAL_TOKEN_DIR", "QWEN_PORTAL_AUTH_FILE")
    process_auth("auth.kimi_code.json", "KIMI_CODE_TOKEN_DIR", "KIMI_CODE_AUTH_FILE")

    info("Ensuring required settings ...")
    if upsert_env_var("LITELLM_LOCAL_MODEL_COST_MAP", "true"):
        changed = True

    if not changed:
        console.print()
        info("All paths and settings already up to date.")
    else:
        console.print()
        info(".env updated — no existing entries were removed.")
