"""Gemini CLI OAuth authentication (browser PKCE)."""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlencode

from ..common.formatting import console
from ..common.paths import PROJECT_DIR
from .core import (
    _generate_pkce, _http_post, _http_get,
    _is_headless, _get_auth_code, _show_token,
)

# ── Constants ──────────────────────────────────────────────────────────────

GEMINI_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GEMINI_TOKEN_URL = "https://oauth2.googleapis.com/token"
GEMINI_USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json"
GEMINI_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com"
GEMINI_REDIRECT_PORT = 8085
GEMINI_REDIRECT_URI = f"http://localhost:{GEMINI_REDIRECT_PORT}/oauth2callback"
GEMINI_SCOPES = (
    "https://www.googleapis.com/auth/cloud-platform "
    "https://www.googleapis.com/auth/userinfo.email "
    "https://www.googleapis.com/auth/userinfo.profile"
)

_CID_RE = re.compile(r"\d+-[a-z0-9]+\.apps\.googleusercontent\.com")
_CSEC_RE = re.compile(r"GOCSPX-[A-Za-z0-9_-]+")


def _gemini_auth_file() -> Path:
    d = os.getenv("GEMINI_CLI_TOKEN_DIR", str(PROJECT_DIR))
    n = os.getenv("GEMINI_CLI_AUTH_FILE", "auth.gemini_cli.json")
    return Path(d) / n


def _find_oauth2_js() -> Optional[str]:
    """Find gemini-cli-core's oauth2.js across npm, bun, pnpm, yarn layouts."""
    OAUTH_SUBPATH = "@google/gemini-cli-core/dist/src/code_assist/oauth2.js"

    candidates = []

    gemini_bin = shutil.which("gemini")
    if gemini_bin:
        real = os.path.realpath(gemini_bin)
        # Walk up from the resolved binary looking for node_modules
        d = os.path.dirname(real)
        for _ in range(10):
            nm = os.path.join(d, "node_modules", OAUTH_SUBPATH)
            if os.path.isfile(nm):
                return nm
            parent = os.path.dirname(d)
            if parent == d:
                break
            d = parent

    # Common global install paths
    home = os.path.expanduser("~")
    candidates += [
        # bun
        os.path.join(home, ".bun/install/global/node_modules", OAUTH_SUBPATH),
        # npm (macOS Homebrew)
        "/usr/local/lib/node_modules/" + OAUTH_SUBPATH,
        # npm (Linux)
        "/usr/lib/node_modules/" + OAUTH_SUBPATH,
        # npm prefix
        os.path.join(home, ".npm-global/lib/node_modules", OAUTH_SUBPATH),
        # nvm
        *(
            [os.path.join(os.getenv("NVM_DIR", ""), f"versions/node/{v}/lib/node_modules", OAUTH_SUBPATH)
             for v in os.listdir(os.path.join(os.getenv("NVM_DIR", home + "/.nvm"), "versions/node"))
            ] if os.path.isdir(os.path.join(os.getenv("NVM_DIR", home + "/.nvm"), "versions/node")) else []
        ),
    ]

    for p in candidates:
        if os.path.isfile(p):
            return p
    return None


def _gemini_creds() -> tuple:
    cid = os.getenv("GEMINI_CLI_OAUTH_CLIENT_ID")
    csec = os.getenv("GEMINI_CLI_OAUTH_CLIENT_SECRET")
    if cid and csec:
        return cid, csec

    oauth_js = _find_oauth2_js()
    if oauth_js:
        try:
            txt = open(oauth_js).read()
            m_id, m_sec = _CID_RE.search(txt), _CSEC_RE.search(txt)
            if m_id and m_sec:
                return m_id.group(), m_sec.group()
        except Exception:
            pass

    raise RuntimeError(
        "Cannot resolve Gemini CLI OAuth credentials.\n"
        "Add to .env:\n"
        "  GEMINI_CLI_OAUTH_CLIENT_ID=...\n"
        "  GEMINI_CLI_OAUTH_CLIENT_SECRET=...\n"
        "Or install: npm/bun install -g @google/gemini-cli"
    )


def _discover_project(token: str) -> Optional[str]:
    env_project = os.getenv("GOOGLE_CLOUD_PROJECT") or os.getenv("GOOGLE_CLOUD_PROJECT_ID")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    try:
        body = {}
        if env_project:
            body["cloudaicompanionProject"] = env_project

        data = _http_post(
            f"{GEMINI_CODE_ASSIST_URL}/v1internal:loadCodeAssist",
            json_body=body, headers=headers,
        )

        cap = data.get("cloudaicompanionProject")
        if isinstance(cap, dict):
            return cap.get("id")
        if isinstance(cap, str):
            return cap

        pid = data.get("projectId") or data.get("project_id")
        if pid:
            return pid
    except Exception as e:
        console.print(f"[yellow]  loadCodeAssist failed (non-fatal): {e}[/]")

    # Fall back to listing GCP projects
    found_project = env_project
    if not found_project:
        try:
            projects = _http_get(
                "https://cloudresourcemanager.googleapis.com/v1/projects",
                headers={"Authorization": f"Bearer {token}"},
            ).get("projects", [])
            for p in projects:
                if "gemini" in p.get("name", "").lower() or "lang" in p.get("projectId", ""):
                    found_project = p["projectId"]
                    break
            if not found_project and projects:
                found_project = projects[0]["projectId"]
            if found_project:
                console.print(f"[dim]  Using GCP project: {found_project}[/]")
        except Exception as e:
            console.print(f"[yellow]  GCP project listing failed (non-fatal): {e}[/]")

    # Onboard the project with Code Assist if we found one
    if found_project:
        try:
            _http_post(
                f"{GEMINI_CODE_ASSIST_URL}/v1internal:onboardUser",
                json_body={
                    "tierId": "standard-tier",
                    "cloudaicompanionProject": found_project,
                    "metadata": {"ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED"},
                },
                headers=headers,
            )
        except Exception:
            pass
        # Also enable the Code Assist API on the project
        try:
            _http_post(
                f"https://serviceusage.googleapis.com/v1/projects/{found_project}/services/cloudaicompanion.googleapis.com:enable",
                json_body={}, headers=headers,
            )
        except Exception:
            pass

    return found_project


def gemini_login() -> dict:
    cid, csec = _gemini_creds()
    verifier, challenge = _generate_pkce()
    state = secrets.token_urlsafe(16)

    params = {
        "client_id": cid, "response_type": "code",
        "redirect_uri": GEMINI_REDIRECT_URI, "scope": GEMINI_SCOPES,
        "code_challenge": challenge, "code_challenge_method": "S256",
        "state": state, "access_type": "offline", "prompt": "consent",
    }
    auth_url = f"{GEMINI_AUTH_URL}?{urlencode(params)}"

    console.print()
    console.print("[bold]Gemini CLI OAuth Login[/]")
    console.print("[dim]" + "─" * 40 + "[/]")

    if not _is_headless():
        console.print("Opening browser...")
        console.print("Sign in with your Google account.")
        console.print(f"Waiting for callback on localhost:{GEMINI_REDIRECT_PORT}...\n")
    else:
        console.print("Sign in with your Google account.")

    code = _get_auth_code(auth_url, GEMINI_REDIRECT_PORT, "/oauth2callback", state)

    console.print("[green]✓ Got authorization code. Exchanging for tokens...[/]")
    data = _http_post(GEMINI_TOKEN_URL, data={
        "grant_type": "authorization_code", "code": code,
        "redirect_uri": GEMINI_REDIRECT_URI, "client_id": cid,
        "client_secret": csec, "code_verifier": verifier,
    })

    at = data["access_token"]
    rt = data.get("refresh_token")
    if not rt:
        raise RuntimeError("No refresh_token received. Try again.")

    console.print("[dim]  Discovering project & email...[/]")
    pid = _discover_project(at)
    email = None
    try:
        email = _http_get(GEMINI_USERINFO_URL, headers={"Authorization": f"Bearer {at}"}).get("email")
    except Exception:
        pass

    record = {
        "access_token": at, "refresh_token": rt,
        "expires_at": int(time.time() + data.get("expires_in", 3600)),
        "project_id": pid, "email": email,
    }
    f = _gemini_auth_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(record, indent=2) + "\n")
    console.print(f"[green]✓ Saved to {f}[/]")
    _show_token("Gemini CLI", record)
    return record


def gemini_refresh() -> dict:
    f = _gemini_auth_file()
    if not f.exists():
        raise RuntimeError(f"No auth file at {f}. Run 'auth gemini' first.")
    auth = json.loads(f.read_text())
    rt = auth.get("refresh_token")
    if not rt:
        raise RuntimeError("No refresh_token. Run 'auth gemini' to re-login.")

    cid, csec = _gemini_creds()
    console.print("[dim]Refreshing Gemini CLI token...[/]")
    data = _http_post(GEMINI_TOKEN_URL, data={
        "grant_type": "refresh_token", "refresh_token": rt,
        "client_id": cid, "client_secret": csec,
    })

    at = data["access_token"]
    auth["access_token"] = at
    auth["refresh_token"] = data.get("refresh_token", rt)
    auth["expires_at"] = int(time.time() + data.get("expires_in", 3600))

    if not auth.get("project_id"):
        console.print("[dim]  Discovering project...[/]")
        auth["project_id"] = _discover_project(at)

    if not auth.get("email"):
        try:
            auth["email"] = _http_get(
                GEMINI_USERINFO_URL, headers={"Authorization": f"Bearer {at}"}
            ).get("email")
        except Exception:
            pass

    f.write_text(json.dumps(auth, indent=2) + "\n")
    console.print(f"[green]✓ Refreshed → {f}[/]")
    _show_token("Gemini CLI", auth)
    return auth
