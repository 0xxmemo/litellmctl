"""LitellmCTL UI management."""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import time

from ..common.paths import (
    PROJECT_DIR, BIN_DIR, LOG_DIR, ENV_FILE,
    GATEWAY_LAUNCHD_LABEL, GATEWAY_LAUNCHD_PLIST,
    GATEWAY_SYSTEMD_UNIT, GATEWAY_SYSTEMD_FILE,
    GATEWAY_PIDFILE, SYSTEMD_DIR,
)
from ..common.env import load_env
from ..common.formatting import console, info, warn, error
from ..common.network import http_check
from ..common.platform import is_macos, is_linux, has_systemd_user
from ..common.process import pids_on_port


def _ensure_bun_path() -> None:
    bun_dir = os.path.expanduser("~/.bun/bin")
    if os.path.isdir(bun_dir):
        os.environ["PATH"] = f"{bun_dir}:{os.environ.get('PATH', '')}"


def _bun_bin() -> str | None:
    """Return full path to bun binary, or None."""
    _ensure_bun_path()
    return shutil.which("bun")


def _gateway_port() -> int:
    return int(os.environ.get("GATEWAY_PORT", "14041"))


def _load_gateway_env() -> None:
    """Load gateway-local .env so GATEWAY_PORT is available."""
    env_path = PROJECT_DIR / "gateway" / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())


def _parse_root_env_for_plist() -> str:
    """Generate plist XML env block from root .env."""
    if not ENV_FILE.exists():
        return ""
    block = ""
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if key:
            block += f"    <key>{key}</key>\n    <string>{value}</string>\n"
    return block


def _ensure_gateway_launch_wrapper() -> None:
    """Ensure gateway-launch.sh is executable (e.g. after clone without +x)."""
    path = BIN_DIR / "gateway-launch.sh"
    if not path.exists():
        return
    try:
        os.chmod(path, path.stat().st_mode | 0o111)
    except OSError:
        pass


def _parse_root_env_for_systemd() -> str:
    """Generate systemd env lines from root .env."""
    if not ENV_FILE.exists():
        return ""
    lines = ""
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        lines += f"Environment={line}\n"
    return lines


def gateway_is_running() -> bool:
    _ensure_bun_path()
    port = _gateway_port()
    return http_check(f"http://localhost:{port}/api/health", timeout=2)


# ── launchd (macOS) ──────────────────────────────────────────────────────────

def _gateway_launchd_install(bun: str, port: int) -> None:
    _ensure_gateway_launch_wrapper()
    gateway_dir = PROJECT_DIR / "gateway"
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    GATEWAY_LAUNCHD_PLIST.parent.mkdir(parents=True, exist_ok=True)

    env_block = _parse_root_env_for_plist()
    launch_sh = BIN_DIR / "gateway-launch.sh"

    plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{GATEWAY_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{launch_sh}</string>
    <string>{bun}</string>
    <string>--env-file=../.env</string>
    <string>run</string>
    <string>index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>{gateway_dir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>{os.path.dirname(bun)}:/usr/local/bin:/usr/bin:/bin</string>
{env_block}    <key>GATEWAY_SUPERVISOR</key>
    <string>launchd</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>{LOG_DIR}/gateway.log</string>
  <key>StandardErrorPath</key>
  <string>{LOG_DIR}/gateway-error.log</string>
</dict>
</plist>"""

    GATEWAY_LAUNCHD_PLIST.write_text(plist)

    uid = os.getuid()
    subprocess.call(["launchctl", "bootout", f"gui/{uid}/{GATEWAY_LAUNCHD_LABEL}"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ret = subprocess.call(["launchctl", "bootstrap", f"gui/{uid}", str(GATEWAY_LAUNCHD_PLIST)])
    if ret != 0:
        warn("launchd bootstrap failed, retrying once ...")
        subprocess.call(["launchctl", "bootout", f"gui/{uid}/{GATEWAY_LAUNCHD_LABEL}"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
        subprocess.check_call(["launchctl", "bootstrap", f"gui/{uid}", str(GATEWAY_LAUNCHD_PLIST)])

    info(f"Installed launchd service ({GATEWAY_LAUNCHD_LABEL})")
    info(f"LitellmCTL starting on port {port} (auto-starts on login, auto-restarts on crash)")


def _gateway_launchd_stop() -> None:
    uid = os.getuid()
    ret = subprocess.call(["launchctl", "bootout", f"gui/{uid}/{GATEWAY_LAUNCHD_LABEL}"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if ret == 0:
        info("LitellmCTL service stopped.")
    else:
        warn("LitellmCTL service not running.")


def _gateway_launchd_is_running() -> bool:
    if not shutil.which("launchctl"):
        return False
    uid = os.getuid()
    return subprocess.call(
        ["launchctl", "print", f"gui/{uid}/{GATEWAY_LAUNCHD_LABEL}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ) == 0


# ── systemd (Linux) ─────────────────────────────────────────────────────────

def _gateway_systemd_install(bun: str, port: int) -> None:
    _ensure_gateway_launch_wrapper()
    gateway_dir = PROJECT_DIR / "gateway"
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    SYSTEMD_DIR.mkdir(parents=True, exist_ok=True)

    env_lines = _parse_root_env_for_systemd()
    launch_sh = BIN_DIR / "gateway-launch.sh"

    unit = f"""[Unit]
Description=LitellmCTL UI
After=network.target

[Service]
Type=simple
WorkingDirectory={gateway_dir}
ExecStart={launch_sh} {bun} --env-file=../.env run index.ts
Restart=on-failure
RestartSec=3

Environment=PATH={os.path.dirname(bun)}:/usr/local/bin:/usr/bin:/bin
Environment=GATEWAY_SUPERVISOR=systemd
{env_lines}
StandardOutput=append:{LOG_DIR}/gateway.log
StandardError=append:{LOG_DIR}/gateway-error.log

[Install]
WantedBy=default.target"""

    GATEWAY_SYSTEMD_FILE.write_text(unit)

    subprocess.call(["systemctl", "--user", "daemon-reload"])
    subprocess.call(["systemctl", "--user", "enable", GATEWAY_SYSTEMD_UNIT])
    subprocess.call(["systemctl", "--user", "start", GATEWAY_SYSTEMD_UNIT])

    info(f"Installed systemd user service ({GATEWAY_SYSTEMD_UNIT})")
    info(f"LitellmCTL starting on port {port} (auto-starts on login, auto-restarts on crash)")

    # Ensure linger so service survives logout
    import shutil
    if shutil.which("loginctl"):
        result = subprocess.run(
            ["loginctl", "show-user", os.environ.get("USER", ""), "--property=Linger"],
            capture_output=True, text=True,
        )
        if "yes" not in result.stdout:
            warn(f"Enabling loginctl linger for {os.environ.get('USER', '')} (keeps service running after logout)")
            subprocess.call(["loginctl", "enable-linger", os.environ.get("USER", "")],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _gateway_systemd_stop() -> None:
    ret = subprocess.call(["systemctl", "--user", "stop", GATEWAY_SYSTEMD_UNIT],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if ret == 0:
        info("LitellmCTL service stopped.")
    else:
        warn("LitellmCTL service not running.")


def _gateway_systemd_is_running() -> bool:
    if not shutil.which("systemctl"):
        return False
    return subprocess.call(
        ["systemctl", "--user", "is-active", GATEWAY_SYSTEMD_UNIT],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ) == 0


# ── nohup fallback ───────────────────────────────────────────────────────────

def _gateway_nohup_start(bun: str, port: int) -> None:
    _ensure_gateway_launch_wrapper()
    gateway_dir = PROJECT_DIR / "gateway"
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    launch_sh = BIN_DIR / "gateway-launch.sh"
    env = os.environ.copy()
    env["GATEWAY_SUPERVISOR"] = "nohup"
    log_f = open(LOG_DIR / "gateway.log", "a")
    proc = subprocess.Popen(
        [str(launch_sh), bun, "--env-file=../.env", "run", "index.ts"],
        cwd=str(gateway_dir),
        stdout=log_f, stderr=log_f,
        start_new_session=True,
        env=env,
    )
    GATEWAY_PIDFILE.write_text(str(proc.pid))
    info(f"LitellmCTL started in background (PID {proc.pid}, port {port})")
    warn("Note: nohup mode has no auto-restart on crash. Use systemd for crash recovery.")


def _gateway_nohup_stop() -> None:
    if GATEWAY_PIDFILE.exists():
        try:
            pid = int(GATEWAY_PIDFILE.read_text().strip())
            os.kill(pid, 0)
            os.kill(pid, 15)
            time.sleep(1)
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass
            info(f"LitellmCTL stopped (PID {pid})")
        except (ValueError, ProcessLookupError):
            info("LitellmCTL process not running")
        GATEWAY_PIDFILE.unlink(missing_ok=True)
    else:
        port = _gateway_port()
        found = False
        for pid in pids_on_port(port):
            try:
                result = subprocess.run(
                    ["ps", "-p", str(pid), "-o", "command="],
                    capture_output=True, text=True,
                )
                if any(x in result.stdout for x in ("bun", "node", "index.ts")):
                    os.kill(pid, 9)
                    info(f"LitellmCTL stopped (PID {pid} on port {port})")
                    found = True
            except Exception:
                pass
        if not found:
            info("No gateway process found")


# ── Public start/stop ────────────────────────────────────────────────────────

def gateway_start_foreground() -> None:
    """Replace the current process with `bun run index.ts` in the gateway dir.

    Used by the docker harness where s6-overlay is the supervisor. No PID
    files, no launchd/systemd, no health polling — the caller owns lifecycle.
    """
    from ..common.harness import is_docker
    gateway_dir = PROJECT_DIR / "gateway"
    if not gateway_dir.exists():
        error(f"gateway/ directory not found at {gateway_dir}")
        raise SystemExit(1)

    _load_gateway_env()
    bun = _bun_bin()
    if not bun:
        error("Bun not found. Install with: curl -fsSL https://bun.sh/install | bash")
        raise SystemExit(1)

    os.environ["GATEWAY_SUPERVISOR"] = "foreground"
    if is_docker():
        os.environ.setdefault("LITELLM_HARNESS", "docker")

    env_file = PROJECT_DIR / ".env"
    argv = [bun]
    if env_file.exists():
        argv.append(f"--env-file={env_file}")
    argv += ["run", "index.ts"]

    os.chdir(gateway_dir)
    info(f"Starting gateway on port {_gateway_port()} (foreground) ...")
    os.execvp(argv[0], argv)


def gateway_start() -> None:
    from ..common.harness import is_docker
    if is_docker():
        gateway_start_foreground()
        return

    gateway_dir = PROJECT_DIR / "gateway"

    if not gateway_dir.exists():
        error(f"gateway/ directory not found at {gateway_dir}")
        error("Run 'litellmctl install --with-gateway' to install")
        return

    _load_gateway_env()
    port = _gateway_port()

    # Refresh launchd/systemd/nohup even when healthy so upgrades (wrapper, throttle,
    # env) apply — same as re-running install on an old checkout.
    if gateway_is_running():
        info(f"LitellmCTL already running on port {port} — refreshing supervisor config ...")
        gateway_stop()
        time.sleep(1)
        # Stray bun after a partial stop (e.g. old nohup + manual run)
        for pid in pids_on_port(port):
            try:
                result = subprocess.run(
                    ["ps", "-p", str(pid), "-o", "command="],
                    capture_output=True, text=True,
                )
                cmd = result.stdout or ""
                if any(x in cmd for x in ("bun", "node")) and "index.ts" in cmd:
                    os.kill(pid, 9)
            except (ProcessLookupError, PermissionError):
                pass

    bun = _bun_bin()
    if not bun:
        error("Bun not found. Install with: curl -fsSL https://bun.sh/install | bash")
        return

    if is_macos():
        _gateway_launchd_install(bun, port)
    elif is_linux() and has_systemd_user():
        _gateway_systemd_install(bun, port)
    else:
        _gateway_nohup_start(bun, port)

    # Wait for gateway to become healthy
    for _ in range(8):
        time.sleep(1)
        if gateway_is_running():
            info(f"Web UI: http://localhost:{port}")
            # Auto-start hydroxide SMTP bridge if installed and authenticated
            try:
                from .protonmail import hydroxide_start
                hydroxide_start()
            except Exception:
                pass
            return
    warn("LitellmCTL started but not responding yet")
    warn(f"Check logs: tail -f {LOG_DIR}/gateway.log")


def gateway_stop() -> None:
    if is_macos() and _gateway_launchd_is_running():
        _gateway_launchd_stop()
    elif is_linux() and _gateway_systemd_is_running():
        _gateway_systemd_stop()
    else:
        _gateway_nohup_stop()


def gateway_status() -> None:
    port = _gateway_port()
    console.print("[bold]LitellmCTL[/]")
    if not (PROJECT_DIR / "gateway").exists():
        console.print("  Status:   [yellow]not installed[/]")
        console.print("  [dim]Install: litellmctl install --with-gateway[/]")
    elif gateway_is_running():
        # Show which service manager is supervising
        if is_macos() and _gateway_launchd_is_running():
            svc = "launchd"
        elif is_linux() and _gateway_systemd_is_running():
            svc = "systemd"
        else:
            svc = "nohup"
        console.print(f"  Status:   [green]running[/] ({svc})")
        console.print(f"  Port:     {port}")
        console.print(f"  Web UI:   http://localhost:{port}")
    else:
        console.print("  Status:   [yellow]stopped[/]")
        console.print(f"  Port:     {port}")
        console.print("  [dim]Start: litellmctl start gateway[/]")
    console.print()


def install_gateway() -> bool:
    gateway_dir = PROJECT_DIR / "gateway"
    if not gateway_dir.exists():
        warn(f"gateway/ directory not found at {gateway_dir}")
        return False

    _ensure_bun_path()
    if not shutil.which("bun"):
        info("Bun not found — installing Bun ...")
        ret = subprocess.call(["bash", "-c", "curl -fsSL https://bun.sh/install | bash"])
        if ret != 0:
            warn("Bun installation failed")
            return False
        _ensure_bun_path()

    info("Installing gateway dependencies ...")
    ret = subprocess.call(["bun", "install"], cwd=str(gateway_dir))
    if ret != 0:
        warn("LitellmCTL dependency installation failed")
        return False
    info("LitellmCTL dependencies installed")

    info("Building gateway frontend ...")
    ret = subprocess.call(["bun", "run", "build"], cwd=str(gateway_dir))
    if ret != 0:
        warn("LitellmCTL frontend build failed — UI may not render correctly")
    else:
        info("LitellmCTL frontend built")

    env_path = gateway_dir / ".env"
    if not env_path.exists():
        example = gateway_dir / ".env.example"
        if example.exists():
            info("Creating gateway .env from .env.example ...")
            import shutil as sh
            sh.copy2(example, env_path)
            master_key = os.environ.get("LITELLM_MASTER_KEY", "")
            if master_key:
                text = env_path.read_text()
                text = text.replace(
                    "LITELLM_MASTER_KEY=",
                    f"LITELLM_MASTER_KEY={master_key}",
                )
                env_path.write_text(text)

    info(f"LitellmCTL installed at {gateway_dir}")
    info("Start with: litellmctl start gateway")
    return True


def uninstall_gateway() -> None:
    gateway_dir = PROJECT_DIR / "gateway"
    console.print("\n  [bold]LitellmCTL[/]")
    if not gateway_dir.exists():
        console.print("  Not installed.\n")
        return
    if gateway_is_running():
        gateway_stop()

    # Clean up service files
    if is_macos() and GATEWAY_LAUNCHD_PLIST.exists():
        uid = os.getuid()
        subprocess.call(["launchctl", "bootout", f"gui/{uid}/{GATEWAY_LAUNCHD_LABEL}"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        GATEWAY_LAUNCHD_PLIST.unlink(missing_ok=True)
        info("Removed gateway launchd service.")
    elif is_linux() and GATEWAY_SYSTEMD_FILE.exists():
        subprocess.call(["systemctl", "--user", "stop", GATEWAY_SYSTEMD_UNIT],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.call(["systemctl", "--user", "disable", GATEWAY_SYSTEMD_UNIT],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        GATEWAY_SYSTEMD_FILE.unlink(missing_ok=True)
        subprocess.call(["systemctl", "--user", "daemon-reload"])
        info("Removed gateway systemd service.")

    console.print(f"  To remove the gateway directory:\n")
    console.print(f"      rm -rf {gateway_dir}\n")


def _gateway_db_path() -> str:
    """Return the SQLite DB path (env override or gateway/gateway.db)."""
    override = os.environ.get("GATEWAY_DB_PATH")
    if override:
        return override
    return str(PROJECT_DIR / "gateway" / "gateway.db")


def _open_gateway_db() -> sqlite3.Connection | None:
    path = _gateway_db_path()
    if not os.path.exists(path):
        error(f"LitellmCTL DB not found at {path}")
        error("Start the gateway once (litellmctl start gateway) to create it.")
        return None
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


VALID_ROLES = ("guest", "user", "admin")


def gateway_set_role(email: str, role: str) -> None:
    """Set a user's role directly in the gateway SQLite DB."""
    load_env()
    if role not in VALID_ROLES:
        error(f"Invalid role '{role}'. Choose from: {', '.join(VALID_ROLES)}")
        return

    conn = _open_gateway_db()
    if conn is None:
        return
    try:
        email_norm = email.lower()
        now_ms = int(time.time() * 1000)
        cur = conn.execute("SELECT 1 FROM validated_users WHERE email = ?", (email_norm,))
        existed = cur.fetchone() is not None
        conn.execute(
            """
            INSERT INTO validated_users (email, role, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET role = excluded.role
            """,
            (email_norm, role, now_ms),
        )
        conn.commit()
        action = "updated" if existed else "created"
        info(f"{action} {email} → [bold]{role}[/]")
    except sqlite3.Error as e:
        error(f"Failed to update role: {e}")
    finally:
        conn.close()


def gateway_user_list() -> None:
    """List all gateway users and their roles."""
    load_env()
    conn = _open_gateway_db()
    if conn is None:
        return
    try:
        rows = conn.execute(
            "SELECT email, role FROM validated_users ORDER BY role, email"
        ).fetchall()
    except sqlite3.Error as e:
        error(f"Failed to list users: {e}")
        conn.close()
        return
    conn.close()

    if not rows:
        info("No users found")
        return

    role_color = {"admin": "red", "user": "green", "guest": "yellow"}
    console.print(f"\n  {'EMAIL':<40} ROLE")
    console.print(f"  {'─'*40} ────")
    for r in rows:
        color = role_color.get(r["role"], "white")
        console.print(f"  {r['email']:<40} [{color}]{r['role']}[/]")
    console.print()


import re
import urllib.parse
import urllib.request
import urllib.error

# ── Route parser (reads gateway/routes/*.ts as source of truth) ──────────────

_EXPORT_RE = re.compile(r'export\s+const\s+\w+Routes\s*=\s*\{(.*?)\};', re.DOTALL)
_ROUTE_LINE_RE = re.compile(r'"(/[^"]+)":\s*\{([^}]+)\}')
_METHOD_RE = re.compile(r'\b(GET|POST|PUT|PATCH|DELETE)\b')
_COMMENT_RE = re.compile(r'//\s*(GET|POST|PUT|PATCH|DELETE)\s+(/\S+)\s*[—–-]+\s*(.*)')

ACTION_METHODS = {"create": "POST", "update": "PUT", "delete": "DELETE", "set": "PUT"}
METHOD_COLOR = {"GET": "green", "POST": "blue", "PUT": "yellow", "PATCH": "cyan", "DELETE": "red"}


def _parse_route_exports() -> list[dict]:
    """Parse gateway/routes/*.ts to extract all API routes from export blocks."""
    routes_dir = PROJECT_DIR / "gateway" / "routes"
    if not routes_dir.is_dir():
        return []

    descs: dict[tuple[str, str], str] = {}
    routes: list[dict] = []

    for ts_file in sorted(routes_dir.glob("*.ts")):
        text = ts_file.read_text()
        for cm in _COMMENT_RE.finditer(text):
            descs[(cm.group(1), cm.group(2))] = cm.group(3).strip()
        for em in _EXPORT_RE.finditer(text):
            for rm in _ROUTE_LINE_RE.finditer(em.group(1)):
                path = rm.group(1)
                for method in _METHOD_RE.findall(rm.group(2)):
                    routes.append({
                        "method": method,
                        "path": path,
                        "desc": descs.get((method, path), ""),
                    })

    return routes


def _path_to_cmd(path: str) -> list[str]:
    """Convert API path to command segments: /api/stats/user → ['stats','user']."""
    parts = path.strip("/").split("/")
    if parts[0] == "api":
        parts = parts[1:]
    return [p for p in parts if p and not p.startswith("_")]


def _find_route(routes: list[dict], url_path: str, method: str | None = None) -> dict | None:
    """Match a URL path against known routes (supports :param and * wildcards)."""
    path_parts = url_path.strip("/").split("/")
    for r in routes:
        r_parts = r["path"].strip("/").split("/")
        if len(r_parts) != len(path_parts):
            continue
        if not all(rp.startswith(":") or rp == "*" or rp == pp for rp, pp in zip(r_parts, path_parts)):
            continue
        if method and r["method"] != method:
            continue
        return r
    return None


def _completable_segments(prefix: list[str]) -> list[str]:
    """Return possible next command segments given a prefix (for tab completion)."""
    routes = _parse_route_exports()
    suggestions: set[str] = set()
    for r in routes:
        parts = _path_to_cmd(r["path"])
        if len(parts) <= len(prefix):
            continue
        if parts[:len(prefix)] == prefix:
            seg = parts[len(prefix)]
            if not seg.startswith(":"):
                suggestions.add(seg)
    return sorted(suggestions)


# ── Gateway HTTP helpers ─────────────────────────────────────────────────────

def _gateway_base_url() -> str:
    port = int(os.environ.get("GATEWAY_PORT", "14041"))
    return f"http://localhost:{port}"


def _gateway_secret() -> str | None:
    secret_file = PROJECT_DIR / ".gateway-secret"
    if secret_file.exists():
        return secret_file.read_text().strip()
    return None


def _gateway_request(method: str, url: str, body: bytes | None, secret: str) -> None:
    """Make an authenticated request to the gateway and print the result."""
    headers: dict[str, str] = {"X-Gateway-Secret": secret, "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    elif method in ("POST", "PUT", "PATCH"):
        headers["Content-Type"] = "application/json"
        body = b"{}"

    try:
        req = urllib.request.Request(url, method=method, headers=headers, data=body)
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            try:
                console.print_json(json.dumps(json.loads(raw), indent=2))
            except json.JSONDecodeError:
                console.print(raw)
    except urllib.error.HTTPError as e:
        error(f"HTTP {e.code}: {e.read().decode('utf-8', errors='replace')}")
    except urllib.error.URLError as e:
        error(f"Connection failed: {e.reason}")


# ── Public commands ──────────────────────────────────────────────────────────

def gateway_api(args: list[str], data: str | None = None) -> None:
    """Call a gateway endpoint using human-readable commands.

    Examples:
        litellmctl api health
        litellmctl api stats requests
        litellmctl api admin users
        litellmctl api admin approve email=user@example.com
        litellmctl api keys delete abc123
        litellmctl api search q=hello
    """
    load_env()

    if not args:
        error("Usage: litellmctl api <command...> [-d json] [key=val...]")
        info("Run: litellmctl routes")
        return

    if not gateway_is_running():
        error("LitellmCTL not running — litellmctl start gateway")
        return

    secret = _gateway_secret()
    if not secret:
        error("CLI secret not found — restart gateway to generate it")
        return

    routes = _parse_route_exports()
    if not routes:
        error("No routes found — is the gateway installed?")
        return

    # Separate args into: action words, key=value params, path segments
    method_hint: str | None = None
    kv: dict[str, str] = {}
    segments: list[str] = []

    for a in args:
        lo = a.lower()
        if lo in ACTION_METHODS and method_hint is None:
            method_hint = ACTION_METHODS[lo]
        elif "=" in a and not a.startswith("-"):
            k, _, v = a.partition("=")
            kv[k] = v
        else:
            segments.append(a)

    if not segments:
        error("No command specified")
        return

    # Build URL path from segments
    if segments[0] == "v1":
        url_path = "/" + "/".join(segments)
    else:
        url_path = "/api/" + "/".join(segments)

    # Determine HTTP method
    has_body = bool(data or kv)
    if method_hint:
        method = method_hint
    elif has_body:
        # Find a write method for this path
        method = "POST"
        for m in ("POST", "PUT", "PATCH"):
            if _find_route(routes, url_path, m):
                method = m
                break
    else:
        method = "GET"

    # Validate route exists
    route = _find_route(routes, url_path, method) or _find_route(routes, url_path)
    if not route:
        error(f"Unknown command: {' '.join(args)}")
        info("Run: litellmctl routes")
        return

    # Use the matched route's method if our inferred one has no match
    if not _find_route(routes, url_path, method):
        method = route["method"]

    # Build full URL
    base = _gateway_base_url()
    full_url = f"{base}{url_path}"
    if method == "GET" and kv:
        full_url += "?" + urllib.parse.urlencode(kv)

    # Build body
    body: bytes | None = None
    if method in ("POST", "PUT", "PATCH"):
        if data:
            body = data.encode("utf-8")
        elif kv:
            body = json.dumps(kv).encode("utf-8")

    _gateway_request(method, full_url, body, secret)


def gateway_routes() -> None:
    """List all gateway API routes parsed from TypeScript source files."""
    routes = _parse_route_exports()
    if not routes:
        error("No routes found — is the gateway installed?")
        return

    console.print(f"\n  {'CMD':<36} {'METHOD':<8} [dim]DESCRIPTION[/]")
    console.print(f"  {'───':<36} {'──────':<8} [dim]───────────[/]")
    for r in sorted(routes, key=lambda x: (x["path"], x["method"])):
        cmd = " ".join(_path_to_cmd(r["path"]))
        method = r["method"]
        color = METHOD_COLOR.get(method, "white")
        desc = r.get("desc", "")
        console.print(f"  {cmd:<36} [{color}]{method:<8}[/] [dim]{desc}[/]")
    console.print(f"\n  [dim]{len(routes)} endpoints[/]\n")
    console.print("  [dim]Usage: litellmctl api <command...> [-d json] [key=val...][/]\n")


def _detach_from_gateway_cgroup_if_needed() -> None:
    """When we're being called as a descendant of the gateway's systemd unit
    (e.g. from the console pty or from the /api/admin/restart handler),
    ``gateway_stop()`` will tear down the whole cgroup and kill this restart
    script before ``gateway_start()`` gets a chance to run. Fork off a fully
    detached child inside a fresh transient scope so the restart survives the
    service going down, then exit. If systemd-run isn't available we skip
    the detach and hope for the best (non-cgroup supervisors usually reparent
    orphans to init rather than killing them).
    """
    if os.environ.get("_LITELLMCTL_RESTART_DETACHED"):
        return
    if not (is_linux() and has_systemd_user()):
        return
    if not shutil.which("systemd-run"):
        return
    try:
        with open("/proc/self/cgroup", encoding="utf-8") as f:
            cgroup = f.read()
    except OSError:
        return
    # The service cgroup path contains e.g. "litellm-gateway.service".
    if f"{GATEWAY_SYSTEMD_UNIT}.service" not in cgroup:
        return

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / "gateway-restart.log"
    # 'ab' so both parent and (spawned) child can concurrently append.
    log_f = open(log_path, "ab")

    env = os.environ.copy()
    env["_LITELLMCTL_RESTART_DETACHED"] = "1"

    litellmctl = str(BIN_DIR / "litellmctl")
    argv = [
        "systemd-run", "--user", "--scope", "--quiet", "--collect",
        f"--unit=litellm-gateway-restart-{os.getpid()}",
        "--",
        litellmctl, "restart", "gateway",
    ]
    info(f"Detaching restart into transient systemd scope (logs: {log_path}) ...")
    # start_new_session=True → setsid() so SIGHUP from a closing pty can't
    # reach us. stdio → log file so writes don't fail when the pty dies.
    subprocess.Popen(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=log_f,
        stderr=log_f,
        start_new_session=True,
        env=env,
        close_fds=True,
    )
    log_f.close()
    # Parent returns success immediately; detached child owns the actual restart.
    raise SystemExit(0)


def gateway_restart() -> None:
    """Rebuild frontend (if bun is available) and restart the gateway."""
    load_env()
    _detach_from_gateway_cgroup_if_needed()
    gateway_stop()
    time.sleep(1)
    bun = _bun_bin()
    if bun:
        gateway_dir = PROJECT_DIR / "gateway"
        info("Building gateway frontend ...")
        ret = subprocess.call([bun, "run", "build"], cwd=str(gateway_dir))
        if ret != 0:
            warn("Frontend build failed — starting anyway")
    gateway_start()


def gateway_migrate_from_mongo(mongo_uri: str | None = None, force: bool = False) -> None:
    """One-shot migration of old MongoDB data into the new SQLite DB.

    Temporarily installs the `mongodb` package, runs the migration script,
    then prompts to remove it.
    """
    load_env()
    gateway_dir = PROJECT_DIR / "gateway"
    script = gateway_dir / "script" / "migrate-mongo-to-sqlite.ts"

    if not script.exists():
        error(f"Migration script not found at {script}")
        return

    uri = mongo_uri or os.environ.get("GATEWAY_MONGODB_URI")
    if not uri:
        error("GATEWAY_MONGODB_URI not set — pass --mongo-uri=... or set the env var")
        return

    _ensure_bun_path()
    if not shutil.which("bun"):
        error("bun not found — install with: curl -fsSL https://bun.sh/install | bash")
        return

    # Ensure mongodb package is available (removed as a runtime dep after refactor)
    pkg_json = gateway_dir / "package.json"
    has_mongo = False
    try:
        import json as _json
        has_mongo = "mongodb" in _json.loads(pkg_json.read_text()).get("dependencies", {})
    except Exception:
        pass

    if not has_mongo:
        info("Installing mongodb package temporarily ...")
        ret = subprocess.call(["bun", "add", "mongodb"], cwd=str(gateway_dir))
        if ret != 0:
            error("Failed to install mongodb package")
            return

    info(f"Migrating from {uri} → SQLite ...")
    env = os.environ.copy()
    env["GATEWAY_MONGODB_URI"] = uri
    args = ["bun", "run", str(script)]
    if force:
        args.append("--force")
    ret = subprocess.call(args, cwd=str(gateway_dir), env=env)

    if not has_mongo:
        info("Removing temporary mongodb package ...")
        subprocess.call(["bun", "remove", "mongodb"], cwd=str(gateway_dir),
                        stdout=subprocess.DEVNULL)

    if ret == 0:
        info("Migration finished successfully.")
        info("Restart the gateway to pick up the new data: litellmctl restart gateway")
    else:
        error(f"Migration exited with code {ret}")
