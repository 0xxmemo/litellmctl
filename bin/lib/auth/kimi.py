"""Kimi Code OAuth authentication (device-code flow)."""

from __future__ import annotations

import json
import os
import platform
import socket
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
from .core import _is_headless, _show_token

# ── Constants ──────────────────────────────────────────────────────────────

KIMI_OAUTH_HOST = "https://auth.kimi.com"
KIMI_DEVICE_AUTH_URL = f"{KIMI_OAUTH_HOST}/api/oauth/device_authorization"
KIMI_TOKEN_URL = f"{KIMI_OAUTH_HOST}/api/oauth/token"
KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
KIMI_VERSION = "1.25.0"
KIMI_USER_AGENT = f"KimiCLI/{KIMI_VERSION}"
KIMI_POLL_INTERVAL = 5
KIMI_DEFAULT_API_BASE = "https://api.kimi.com/coding/v1"


def _kimi_auth_file() -> Path:
    d = os.getenv("KIMI_CODE_TOKEN_DIR", str(PROJECT_DIR))
    n = os.getenv("KIMI_CODE_AUTH_FILE", "auth.kimi_code.json")
    return Path(d) / n


def _kimi_common_headers() -> dict:
    device_id = ""
    device_id_path = Path.home() / ".kimi" / "device_id"
    if device_id_path.exists():
        device_id = device_id_path.read_text().strip()
    return {
        "User-Agent": KIMI_USER_AGENT,
        "X-Msh-Platform": "kimi_cli",
        "X-Msh-Version": KIMI_VERSION,
        "X-Msh-Device-Id": device_id,
        "X-Msh-Device-Name": platform.node() or socket.gethostname(),
        "X-Msh-Device-Model": f"{platform.system()} {platform.release()} {platform.machine()}",
        "X-Msh-Os-Version": platform.version(),
    }


def _kimi_try_sync_cli_creds() -> Optional[dict]:
    """Try to load valid credentials from kimi-cli's ~/.kimi/credentials/kimi-code.json."""
    cli_path = Path.home() / ".kimi" / "credentials" / "kimi-code.json"
    if not cli_path.exists():
        return None
    try:
        data = json.loads(cli_path.read_text())
    except (json.JSONDecodeError, IOError):
        return None

    access_token = data.get("access_token")
    expires_at = data.get("expires_at")
    if not access_token or not expires_at:
        return None
    if time.time() >= float(expires_at) - 60:
        return None

    return {
        "access_token": access_token,
        "refresh_token": data.get("refresh_token"),
        "expires_at": float(expires_at),
        "scope": data.get("scope", "kimi-code"),
        "token_type": data.get("token_type", "Bearer"),
    }


def _kimi_save_to_cli(record: dict) -> None:
    """Sync tokens back to kimi-cli's credential file."""
    cli_path = Path.home() / ".kimi" / "credentials" / "kimi-code.json"
    cli_record = {
        "access_token": record["access_token"],
        "refresh_token": record["refresh_token"],
        "expires_at": record["expires_at"],
        "scope": record.get("scope", "kimi-code"),
        "token_type": record.get("token_type", "Bearer"),
    }
    try:
        cli_path.parent.mkdir(parents=True, exist_ok=True)
        cli_path.write_text(json.dumps(cli_record))
        os.chmod(cli_path, 0o600)
    except OSError:
        pass


def kimi_login() -> dict:
    console.print()
    console.print("[bold]Kimi Code OAuth Login (Device Code)[/]")
    console.print("[dim]" + "─" * 40 + "[/]")
    console.print("[dim]Requesting device code...[/]")

    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        **_kimi_common_headers(),
    }

    if httpx:
        with httpx.Client(timeout=30) as client:
            resp = client.post(
                KIMI_DEVICE_AUTH_URL,
                data={"client_id": KIMI_CLIENT_ID},
                headers=headers,
            )
            resp.raise_for_status()
            device_resp = resp.json()
    else:
        import urllib.request, urllib.parse
        body = urllib.parse.urlencode({"client_id": KIMI_CLIENT_ID}).encode()
        req = urllib.request.Request(KIMI_DEVICE_AUTH_URL, data=body, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as resp:
            device_resp = json.loads(resp.read())

    device_code = device_resp.get("device_code")
    user_code = device_resp.get("user_code")
    verify_url = device_resp.get("verification_uri_complete", "")
    expires_in = int(device_resp.get("expires_in", 600))
    interval = int(device_resp.get("interval", KIMI_POLL_INTERVAL))

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

    deadline = time.time() + expires_in
    while time.time() < deadline:
        time.sleep(max(interval, 1))

        poll_headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            **_kimi_common_headers(),
        }
        poll_data = {
            "client_id": KIMI_CLIENT_ID,
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        }

        try:
            if httpx:
                with httpx.Client(timeout=30) as client:
                    resp = client.post(KIMI_TOKEN_URL, data=poll_data, headers=poll_headers)
                    if resp.status_code == 200:
                        token_data = resp.json()
                        if "access_token" in token_data:
                            break
                    body = resp.json() if resp.status_code < 500 else {}
                    error = body.get("error", "")
                    if error == "expired_token":
                        raise RuntimeError("Device code expired. Please try again.")
                    continue
            else:
                import urllib.request, urllib.parse, urllib.error
                body_bytes = urllib.parse.urlencode(poll_data).encode()
                req = urllib.request.Request(KIMI_TOKEN_URL, data=body_bytes, headers=poll_headers)
                try:
                    with urllib.request.urlopen(req, timeout=30) as resp:
                        token_data = json.loads(resp.read())
                        if "access_token" in token_data:
                            break
                except urllib.error.HTTPError:
                    pass
                continue
        except RuntimeError:
            raise
        except Exception:
            continue
    else:
        raise RuntimeError("Timed out waiting for Kimi device authorization.")

    console.print("[green]✓ Authorization successful! Token obtained.[/]")

    expires_in_secs = float(token_data.get("expires_in", 900))
    record = {
        "access_token": token_data["access_token"],
        "refresh_token": token_data["refresh_token"],
        "expires_at": time.time() + expires_in_secs,
        "scope": token_data.get("scope", "kimi-code"),
        "token_type": token_data.get("token_type", "Bearer"),
    }
    f = _kimi_auth_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(record, indent=2) + "\n")
    _kimi_save_to_cli(record)
    console.print(f"[green]✓ Saved to {f}[/]")
    _show_token("Kimi Code", record)
    return record


def kimi_refresh() -> dict:
    f = _kimi_auth_file()
    if not f.exists():
        synced = _kimi_try_sync_cli_creds()
        if synced:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(json.dumps(synced, indent=2) + "\n")
            console.print(f"[green]✓ Synced from kimi-cli → {f}[/]")
            _show_token("Kimi Code", synced)
            return synced
        raise RuntimeError(f"No auth file at {f}. Run 'auth kimi' or 'kimi login' first.")

    auth = json.loads(f.read_text())
    rt = auth.get("refresh_token")
    if not rt:
        raise RuntimeError("No refresh_token. Run 'auth kimi' to re-login.")

    console.print("[dim]Refreshing Kimi Code token...[/]")
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        **_kimi_common_headers(),
    }
    refresh_body = {
        "grant_type": "refresh_token",
        "refresh_token": rt,
        "client_id": KIMI_CLIENT_ID,
    }

    if httpx:
        with httpx.Client(timeout=30) as client:
            resp = client.post(KIMI_TOKEN_URL, data=refresh_body, headers=headers)
            resp.raise_for_status()
            data = resp.json()
    else:
        import urllib.request
        req = urllib.request.Request(
            KIMI_TOKEN_URL,
            data=urlencode(refresh_body).encode(),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())

    at = data.get("access_token")
    if not at:
        raise RuntimeError(f"Refresh response missing access_token: {data}")

    expires_in_secs = float(data.get("expires_in", 900))
    record = {
        "access_token": at,
        "refresh_token": data.get("refresh_token", rt),
        "expires_at": time.time() + expires_in_secs,
        "scope": data.get("scope", "kimi-code"),
        "token_type": data.get("token_type", "Bearer"),
    }
    f.write_text(json.dumps(record, indent=2) + "\n")
    _kimi_save_to_cli(record)
    console.print(f"[green]✓ Refreshed → {f}[/]")
    _show_token("Kimi Code", record)
    return record
