"""Shared HTTP/OAuth helpers for all auth providers."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import select
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Optional
from urllib.parse import parse_qs, urlparse

try:
    import httpx
except ImportError:
    httpx = None

from ..common.formatting import console


# ── HTTP helpers ───────────────────────────────────────────────────────────


def _http_post(url: str, *, data: Optional[dict] = None,
               json_body: Optional[dict] = None,
               headers: Optional[dict] = None) -> dict:
    if httpx:
        with httpx.Client(timeout=30) as client:
            resp = client.post(url, json=json_body, data=data, headers=headers)
            resp.raise_for_status()
            return resp.json()
    import urllib.request, urllib.parse
    if json_body:
        body = json.dumps(json_body).encode()
        headers = {**(headers or {}), "Content-Type": "application/json"}
    else:
        body = urllib.parse.urlencode(data or {}).encode()
        headers = {**(headers or {}), "Content-Type": "application/x-www-form-urlencoded"}
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _http_get(url: str, headers: Optional[dict] = None) -> dict:
    if httpx:
        with httpx.Client(timeout=30) as client:
            resp = client.get(url, headers=headers)
            resp.raise_for_status()
            return resp.json()
    import urllib.request
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


# ── PKCE / JWT ─────────────────────────────────────────────────────────────


def _generate_pkce() -> tuple:
    verifier = secrets.token_urlsafe(32)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    return verifier, challenge


def _decode_jwt(token: str) -> dict:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {}


# ── OAuth callback server ──────────────────────────────────────────────────


def _capture_callback(port: int, path: str, expected_state: str, timeout: int = 300) -> str:
    result = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path != path:
                self.send_response(404); self.end_headers(); return

            params = parse_qs(parsed.query)
            code = params.get("code", [None])[0]
            state = params.get("state", [None])[0]
            error = params.get("error", [None])[0]

            if error:
                result["error"] = error
            elif state != expected_state:
                result["error"] = f"State mismatch"
            elif code:
                result["code"] = code

            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                b"<html><body><h2>Authentication successful!</h2>"
                b"<p>You can close this tab.</p></body></html>"
            )

        def log_message(self, *args: object) -> None: pass

    server = HTTPServer(("localhost", port), Handler)
    server.timeout = timeout
    server.handle_request()
    server.server_close()

    if "error" in result:
        raise RuntimeError(f"OAuth error: {result['error']}")
    if "code" not in result:
        raise RuntimeError("Timed out waiting for OAuth callback.")
    return result["code"]


# ── Environment detection ──────────────────────────────────────────────────


def _is_headless() -> bool:
    if os.getenv("SSH_CLIENT") or os.getenv("SSH_TTY") or os.getenv("SSH_CONNECTION"):
        return True
    if sys.platform.startswith("linux"):
        if not os.getenv("DISPLAY") and not os.getenv("WAYLAND_DISPLAY"):
            return True
    if os.path.exists("/.dockerenv"):
        return True
    return False


def _extract_code_from_url(url: str, expected_state: str) -> Optional[str]:
    params = parse_qs(urlparse(url).query)
    code = params.get("code", [None])[0]
    state = params.get("state", [None])[0]
    if not code:
        return None
    if state and state != expected_state:
        raise RuntimeError("State mismatch in pasted URL.")
    return code


def _get_auth_code(auth_url: str, port: int, path: str,
                   state: str, timeout: int = 300) -> str:
    headless = _is_headless()

    if not headless:
        webbrowser.open(auth_url)
        return _capture_callback(port, path, state, timeout)

    # Headless / server mode
    print(f"\n  {'Copy and open this URL in your local browser:'}\n")
    print(f"  {auth_url}\n")
    print(f"  After authenticating, do one of:")
    print(f"    A) Paste the redirect URL below")
    print(f"    B) Use SSH tunnel so the callback arrives automatically:")
    print(f"       ssh -L {port}:localhost:{port} <this-server>\n")

    server_result = {}

    def run_server():
        try:
            server_result["code"] = _capture_callback(port, path, state, timeout)
        except Exception as e:
            server_result["error"] = str(e)

    t = threading.Thread(target=run_server, daemon=True)
    t.start()

    sys.stdout.write("  Redirect URL (or wait for callback): ")
    sys.stdout.flush()

    while t.is_alive():
        if "code" in server_result:
            print(f"\n  Callback received via SSH tunnel!")
            return server_result["code"]

        try:
            readable, _, _ = select.select([sys.stdin], [], [], 1.0)
        except (ValueError, OSError):
            t.join(1.0)
            continue

        if readable:
            line = sys.stdin.readline().strip()
            if not line:
                continue
            code = _extract_code_from_url(line, state)
            if code:
                return code
            print("  Could not extract code. Paste the full redirect URL.")
            sys.stdout.write("  Redirect URL: ")
            sys.stdout.flush()

    if "code" in server_result:
        return server_result["code"]
    raise RuntimeError(server_result.get("error", "Timed out waiting for auth code."))


# ── Clipboard ──────────────────────────────────────────────────────────────


def _copy_to_clipboard(text: str) -> bool:
    """Copy text to system clipboard. Returns True on success."""
    import subprocess
    for cmd in (["pbcopy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]):
        try:
            p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
            p.communicate(text.encode())
            if p.returncode == 0:
                return True
        except FileNotFoundError:
            continue
    return False


# ── Token display ──────────────────────────────────────────────────────────


def _expiry_label(d: dict) -> str:
    exp = d.get("expires_at")
    if not exp:
        return "unknown expiry"
    rem = int(exp - time.time())
    if rem <= 0:
        return "EXPIRED"
    return f"{rem // 3600}h {(rem % 3600) // 60}m left"


def _show_token(provider: str, d: dict):
    exp = d.get("expires_at")
    if exp:
        rem = int(exp - time.time())
        if rem > 0:
            expiry = f"[green]{rem // 3600}h {(rem % 3600) // 60}m remaining[/]"
        else:
            expiry = "[red]EXPIRED[/]"
    else:
        expiry = "[yellow]unknown[/]"
    console.print(f"  Provider:   [bold]{provider}[/]")
    if d.get("email"):      console.print(f"  Email:      {d['email']}")
    if d.get("account_id"): console.print(f"  Account:    {d['account_id']}")
    if d.get("project_id"): console.print(f"  Project:    {d['project_id']}")
    console.print(f"  Expires:    {expiry}")
    console.print()
