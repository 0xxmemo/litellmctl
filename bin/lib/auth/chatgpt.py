"""ChatGPT / Codex OAuth authentication (browser PKCE)."""

from __future__ import annotations

import json
import secrets
import time
from pathlib import Path
from urllib.parse import urlencode
import os

from ..common.formatting import console
from ..common.paths import PROJECT_DIR
from .core import (
    _generate_pkce, _decode_jwt, _http_post,
    _is_headless, _get_auth_code, _show_token,
)

# ── Constants ──────────────────────────────────────────────────────────────

CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CHATGPT_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token"
CHATGPT_REDIRECT_PORT = 1455
CHATGPT_REDIRECT_URI = f"http://localhost:{CHATGPT_REDIRECT_PORT}/auth/callback"
CHATGPT_SCOPES = "openid profile email offline_access"


def _chatgpt_auth_file() -> Path:
    d = os.getenv("CHATGPT_TOKEN_DIR", str(PROJECT_DIR))
    n = os.getenv("CHATGPT_AUTH_FILE", "auth.chatgpt.json")
    return Path(d) / n


def chatgpt_login() -> dict:
    verifier, challenge = _generate_pkce()
    state = secrets.token_urlsafe(16)

    params = {
        "response_type": "code",
        "client_id": CHATGPT_CLIENT_ID,
        "redirect_uri": CHATGPT_REDIRECT_URI,
        "scope": CHATGPT_SCOPES,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
        "originator": "codex_cli_rs",
    }
    auth_url = f"{CHATGPT_AUTHORIZE_URL}?{urlencode(params)}"

    console.print()
    console.print("[bold]ChatGPT / Codex OAuth Login[/]")
    console.print("[dim]" + "─" * 40 + "[/]")

    if not _is_headless():
        console.print("Opening browser...")
        console.print("Sign in with your OpenAI account.")
        console.print(f"Waiting for callback on localhost:{CHATGPT_REDIRECT_PORT}...\n")
    else:
        console.print("Sign in with your OpenAI account.")

    code = _get_auth_code(auth_url, CHATGPT_REDIRECT_PORT, "/auth/callback", state)

    console.print("[green]✓ Got authorization code. Exchanging for tokens...[/]")

    data = _http_post(CHATGPT_TOKEN_URL, data={
        "grant_type": "authorization_code",
        "client_id": CHATGPT_CLIENT_ID,
        "code": code,
        "code_verifier": verifier,
        "redirect_uri": CHATGPT_REDIRECT_URI,
    })

    access_token = data["access_token"]
    refresh_token = data["refresh_token"]
    id_token = data.get("id_token")
    claims = _decode_jwt(access_token)
    expires_at = claims.get("exp") or int(time.time() + data.get("expires_in", 3600))
    account_id = claims.get("https://api.openai.com/auth", {}).get("chatgpt_account_id")

    record = {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "id_token": id_token,
        "expires_at": int(expires_at),
        "account_id": account_id,
    }
    f = _chatgpt_auth_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(record, indent=2) + "\n")
    console.print(f"[green]✓ Saved to {f}[/]")
    _show_token("ChatGPT", record)
    return record


def chatgpt_refresh() -> dict:
    f = _chatgpt_auth_file()
    if not f.exists():
        raise RuntimeError(f"No auth file at {f}. Run 'auth chatgpt' first.")
    auth = json.loads(f.read_text())
    rt = auth.get("refresh_token")
    if not rt:
        raise RuntimeError("No refresh_token. Run 'auth chatgpt' to re-login.")

    console.print("[dim]Refreshing ChatGPT token...[/]")
    data = _http_post(CHATGPT_TOKEN_URL, json_body={
        "client_id": CHATGPT_CLIENT_ID,
        "grant_type": "refresh_token",
        "refresh_token": rt,
        "scope": CHATGPT_SCOPES,
    })

    at = data["access_token"]
    claims = _decode_jwt(at)
    expires_at = claims.get("exp") or int(time.time() + data.get("expires_in", 3600))
    account_id = claims.get("https://api.openai.com/auth", {}).get("chatgpt_account_id")

    record = {
        "access_token": at,
        "refresh_token": data.get("refresh_token", rt),
        "id_token": data.get("id_token"),
        "expires_at": int(expires_at),
        "account_id": account_id,
    }
    f.write_text(json.dumps(record, indent=2) + "\n")
    console.print(f"[green]✓ Refreshed → {f}[/]")
    _show_token("ChatGPT", record)
    return record
