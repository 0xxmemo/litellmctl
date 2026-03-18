"""Qwen Portal OAuth authentication (device-code flow)."""

from __future__ import annotations

import json
import os
import time
import webbrowser
from pathlib import Path
from typing import Optional
from urllib.parse import urlencode

try:
    import httpx
except ImportError:
    httpx = None

from ..common.formatting import console
from ..common.paths import PROJECT_DIR
from .core import _generate_pkce, _is_headless, _show_token

# ── Constants ──────────────────────────────────────────────────────────────

QWEN_OAUTH_BASE = "https://chat.qwen.ai"
QWEN_DEVICE_CODE_URL = f"{QWEN_OAUTH_BASE}/api/v1/oauth2/device/code"
QWEN_TOKEN_URL = f"{QWEN_OAUTH_BASE}/api/v1/oauth2/token"
QWEN_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56"
QWEN_OAUTH_SCOPE = "openid profile email model.completion"
QWEN_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
QWEN_USER_AGENT = "qwen-code/1.0.0"
QWEN_POLL_INTERVAL = 2
QWEN_MAX_POLL_INTERVAL = 10


def _qwen_auth_file() -> Path:
    d = os.getenv("QWEN_PORTAL_TOKEN_DIR", str(PROJECT_DIR))
    n = os.getenv("QWEN_PORTAL_AUTH_FILE", "auth.qwen_portal.json")
    return Path(d) / n


def _qwen_request_device_code(code_challenge: str) -> dict:
    """Request a device code from the Qwen OAuth server."""
    import uuid
    form_data = urlencode({
        "client_id": QWEN_CLIENT_ID,
        "scope": QWEN_OAUTH_SCOPE,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    })
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": QWEN_USER_AGENT,
        "x-request-id": str(uuid.uuid4()),
    }
    if httpx:
        with httpx.Client(timeout=30, follow_redirects=True) as client:
            resp = client.post(QWEN_DEVICE_CODE_URL, content=form_data, headers=headers)
            resp.raise_for_status()
            return resp.json()
    import urllib.request
    req = urllib.request.Request(
        QWEN_DEVICE_CODE_URL, data=form_data.encode(),
        headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _qwen_poll_token(device_code: str, code_verifier: str) -> Optional[dict]:
    """Poll for the device token. Returns token data or None if still pending."""
    form_data = urlencode({
        "grant_type": QWEN_DEVICE_GRANT_TYPE,
        "client_id": QWEN_CLIENT_ID,
        "device_code": device_code,
        "code_verifier": code_verifier,
    })
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": QWEN_USER_AGENT,
    }

    if httpx:
        with httpx.Client(timeout=30, follow_redirects=True) as client:
            resp = client.post(QWEN_TOKEN_URL, content=form_data, headers=headers)
            if resp.status_code == 200:
                body = resp.json()
                at = body.get("access_token")
                if at and isinstance(at, str) and len(at) > 0:
                    return body
                if body.get("status") == "pending":
                    return None
                return None
            if resp.status_code == 400:
                try:
                    body = resp.json()
                except Exception:
                    return None
                if body.get("error") == "authorization_pending":
                    return None
                raise RuntimeError(
                    f"Device token error: {body.get('error', 'unknown')} — "
                    f"{body.get('error_description', '')}")
            if resp.status_code == 429:
                return None
            resp.raise_for_status()
    else:
        import urllib.request, urllib.error
        req = urllib.request.Request(
            QWEN_TOKEN_URL, data=form_data.encode(),
            headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = json.loads(resp.read())
                at = body.get("access_token")
                if at and isinstance(at, str) and len(at) > 0:
                    return body
                return None
        except urllib.error.HTTPError as e:
            if e.code in (400, 429):
                return None
            raise
    return None


def _qwen_try_sync_cli_creds() -> Optional[dict]:
    """Try to load valid credentials from Qwen Code CLI's ~/.qwen/oauth_creds.json."""
    cli_path = Path.home() / ".qwen" / "oauth_creds.json"
    if not cli_path.exists():
        return None
    try:
        data = json.loads(cli_path.read_text())
    except (json.JSONDecodeError, IOError):
        return None

    access_token = data.get("access_token")
    expiry_date = data.get("expiry_date")
    if not access_token or not expiry_date:
        return None

    # expiry_date is in milliseconds in Qwen CLI format
    expires_at = expiry_date / 1000.0 if expiry_date > 1e12 else expiry_date
    if time.time() >= expires_at - 60:
        return None  # expired

    return {
        "access_token": access_token,
        "refresh_token": data.get("refresh_token"),
        "expires_at": int(expires_at),
        "resource_url": data.get("resource_url"),
        "token_type": data.get("token_type", "Bearer"),
    }


def qwen_login() -> dict:
    verifier, challenge = _generate_pkce()

    console.print()
    console.print("[bold]Qwen Portal OAuth Login (Device Code)[/]")
    console.print("[dim]" + "─" * 40 + "[/]")
    console.print("[dim]Requesting device code...[/]")

    device_resp = _qwen_request_device_code(challenge)

    device_code = device_resp.get("device_code")
    user_code = device_resp.get("user_code")
    verify_url = device_resp.get("verification_uri_complete") or device_resp.get("verification_uri", "")
    expires_in = int(device_resp.get("expires_in", 600))

    if not device_code:
        raise RuntimeError(f"Device code response missing device_code: {device_resp}")

    console.print()
    if user_code:
        console.print(f"  Your code: [bold]{user_code}[/]")
    console.print(f"  Open this URL in your browser:\n")
    console.print(f"  [cyan]{verify_url}[/]\n")

    if not _is_headless():
        try:
            webbrowser.open(verify_url)
            console.print("[dim]  (Browser opened automatically)[/]")
        except Exception:
            pass

    console.print(f"[dim]\n  Waiting for authorization (expires in {expires_in // 60}m)...\n[/]")

    poll_interval = QWEN_POLL_INTERVAL
    deadline = time.time() + expires_in

    while time.time() < deadline:
        time.sleep(poll_interval)
        try:
            token_data = _qwen_poll_token(device_code, verifier)
        except RuntimeError as e:
            raise RuntimeError(f"Qwen auth failed: {e}")

        if token_data is not None:
            console.print("[green]✓ Authorization successful! Token obtained.[/]")

            at = token_data["access_token"]
            expires_in_secs = token_data.get("expires_in", 3600)
            resource_url = token_data.get("resource_url")

            record = {
                "access_token": at,
                "refresh_token": token_data.get("refresh_token"),
                "expires_at": int(time.time() + expires_in_secs),
                "resource_url": resource_url,
                "token_type": token_data.get("token_type", "Bearer"),
            }
            f = _qwen_auth_file()
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(record, indent=2) + "\n")
            console.print(f"[green]✓ Saved to {f}[/]")
            _show_token("Qwen Portal", record)
            return record

        # No slow_down handling needed — the poll function returns None for 429
        poll_interval = min(poll_interval + 0.5, QWEN_MAX_POLL_INTERVAL)

    raise RuntimeError("Timed out waiting for Qwen device authorization.")


def qwen_refresh() -> dict:
    f = _qwen_auth_file()
    if not f.exists():
        # Try syncing from Qwen CLI
        synced = _qwen_try_sync_cli_creds()
        if synced:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(synced, indent=2) + "\n")
            console.print(f"[green]✓ Synced from Qwen Code CLI → {f}[/]")
            _show_token("Qwen Portal", synced)
            return synced
        raise RuntimeError(f"No auth file at {f}. Run 'auth qwen' first.")

    auth = json.loads(f.read_text())
    rt = auth.get("refresh_token")
    if not rt:
        raise RuntimeError("No refresh_token. Run 'auth qwen' to re-login.")

    console.print("[dim]Refreshing Qwen Portal token...[/]")
    form_data = urlencode({
        "grant_type": "refresh_token",
        "refresh_token": rt,
        "client_id": QWEN_CLIENT_ID,
    })
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": QWEN_USER_AGENT,
    }
    if httpx:
        with httpx.Client(timeout=30, follow_redirects=True) as client:
            resp = client.post(QWEN_TOKEN_URL, content=form_data, headers=headers)
            resp.raise_for_status()
            data = resp.json()
    else:
        import urllib.request
        req = urllib.request.Request(
            QWEN_TOKEN_URL, data=form_data.encode(),
            headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())

    at = data.get("access_token")
    if not at:
        raise RuntimeError(f"Refresh response missing access_token: {data}")

    expires_in_secs = data.get("expires_in", 3600)
    resource_url = data.get("resource_url") or auth.get("resource_url")

    record = {
        "access_token": at,
        "refresh_token": data.get("refresh_token", rt),
        "expires_at": int(time.time() + expires_in_secs),
        "resource_url": resource_url,
        "token_type": data.get("token_type", "Bearer"),
    }
    f.write_text(json.dumps(record, indent=2) + "\n")
    console.print(f"[green]✓ Refreshed → {f}[/]")
    _show_token("Qwen Portal", record)
    return record
