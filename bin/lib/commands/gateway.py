"""Gateway UI management."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time

from ..common.paths import PROJECT_DIR, LOG_DIR
from ..common.env import load_env
from ..common.formatting import console, info, warn, error
from ..common.network import http_check
from ..common.process import pids_on_port


def _ensure_bun_path() -> None:
    bun_dir = os.path.expanduser("~/.bun/bin")
    if os.path.isdir(bun_dir):
        os.environ["PATH"] = f"{bun_dir}:{os.environ.get('PATH', '')}"


def gateway_is_running() -> bool:
    _ensure_bun_path()
    port = int(os.environ.get("GATEWAY_PORT", "14041"))
    return http_check(f"http://localhost:{port}/api/health", timeout=2)


def gateway_start() -> None:
    gateway_dir = PROJECT_DIR / "gateway"

    if not gateway_dir.exists():
        error(f"Gateway directory not found at {gateway_dir}")
        error("Run 'litellmctl install --with-gateway' to install")
        return

    # Load gateway-local .env first so GATEWAY_PORT is available
    env_path = gateway_dir / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())

    port = int(os.environ.get("GATEWAY_PORT", "14041"))

    if gateway_is_running():
        info(f"Gateway already running on port {port}")
        return

    _ensure_bun_path()
    import shutil
    if not shutil.which("bun"):
        error("Bun not found. Install with: curl -fsSL https://bun.sh/install | bash")
        return

    info(f"Starting gateway on port {port} ...")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_f = open(LOG_DIR / "gateway.log", "a")
    proc = subprocess.Popen(
        ["bun", "--env-file=../.env", "run", "index.ts"],
        cwd=str(gateway_dir),
        stdout=log_f, stderr=log_f,
        start_new_session=True,
    )
    (gateway_dir / ".gateway.pid").write_text(str(proc.pid))

    for _ in range(8):
        time.sleep(1)
        if gateway_is_running():
            info(f"Gateway started (PID {proc.pid})")
            info(f"Web UI: http://localhost:{port}")
            # Auto-start hydroxide SMTP bridge if installed and authenticated
            try:
                from .protonmail import hydroxide_start
                hydroxide_start()
            except Exception:
                pass
            return
    warn("Gateway started but not responding yet")
    warn(f"Check logs: tail -f {LOG_DIR}/gateway.log")


def gateway_stop() -> None:
    gateway_dir = PROJECT_DIR / "gateway"
    pid_file = gateway_dir / ".gateway.pid"

    if pid_file.exists():
        try:
            pid = int(pid_file.read_text().strip())
            os.kill(pid, 0)
            os.kill(pid, 15)
            time.sleep(1)
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass
            info(f"Gateway stopped (PID {pid})")
        except (ValueError, ProcessLookupError):
            info("Gateway process not running")
        pid_file.unlink(missing_ok=True)
    else:
        port = int(os.environ.get("GATEWAY_PORT", "14041"))
        found = False
        for pid in pids_on_port(port):
            try:
                result = subprocess.run(
                    ["ps", "-p", str(pid), "-o", "command="],
                    capture_output=True, text=True,
                )
                if any(x in result.stdout for x in ("bun", "node", "index.ts")):
                    os.kill(pid, 9)
                    info(f"Gateway stopped (PID {pid} on port {port})")
                    found = True
            except Exception:
                pass
        if not found:
            info("No gateway process found")


def gateway_status() -> None:
    port = int(os.environ.get("GATEWAY_PORT", "14041"))
    console.print("[bold]Gateway UI[/]")
    if not (PROJECT_DIR / "gateway").exists():
        console.print("  Status:   [yellow]not installed[/]")
        console.print("  [dim]Install: litellmctl install --with-gateway[/]")
    elif gateway_is_running():
        console.print("  Status:   [green]running[/]")
        console.print(f"  Port:     {port}")
        console.print(f"  Web UI:   http://localhost:{port}")
    else:
        console.print("  Status:   [yellow]stopped[/]")
        console.print(f"  Port:     {port}")
        console.print("  [dim]Start: litellmctl gateway start[/]")
    console.print()


def install_gateway() -> bool:
    gateway_dir = PROJECT_DIR / "gateway"
    if not gateway_dir.exists():
        warn(f"Gateway directory not found at {gateway_dir}")
        return False

    _ensure_bun_path()
    import shutil
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
        warn("Gateway dependency installation failed")
        return False
    info("Gateway dependencies installed")

    info("Building gateway frontend ...")
    ret = subprocess.call(["bun", "run", "build"], cwd=str(gateway_dir))
    if ret != 0:
        warn("Gateway frontend build failed — UI may not render correctly")
    else:
        info("Gateway frontend built")

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

    info(f"Gateway installed at {gateway_dir}")
    info("Start with: litellmctl gateway start")
    return True


def uninstall_gateway() -> None:
    gateway_dir = PROJECT_DIR / "gateway"
    console.print("\n  [bold]Gateway UI[/]")
    if not gateway_dir.exists():
        console.print("  Not installed.\n")
        return
    if gateway_is_running():
        console.print("  Running. Stop it first:\n")
        console.print("      litellmctl gateway stop\n")
    console.print(f"  To remove the gateway directory:\n")
    console.print(f"      rm -rf {gateway_dir}\n")


def _gateway_mongo_uri() -> str | None:
    """Return GATEWAY_MONGODB_URI from root .env (already loaded by load_env())."""
    return os.environ.get("GATEWAY_MONGODB_URI")


def _run_mongo_script(script: str) -> subprocess.CompletedProcess:
    """Run a TypeScript snippet via bun inside the gateway directory (uses its node_modules)."""
    _ensure_bun_path()
    gateway_dir = PROJECT_DIR / "gateway"
    with tempfile.NamedTemporaryFile(
        suffix=".ts", delete=False, mode="w", dir=str(gateway_dir)
    ) as f:
        f.write(script)
        tmp = f.name
    try:
        return subprocess.run(
            ["bun", "run", tmp],
            capture_output=True, text=True, timeout=15,
            cwd=str(gateway_dir),
        )
    finally:
        os.unlink(tmp)


VALID_ROLES = ("guest", "user", "admin")


def gateway_set_role(email: str, role: str) -> None:
    """Set a user's role directly in the gateway MongoDB collection."""
    load_env()
    if role not in VALID_ROLES:
        error(f"Invalid role '{role}'. Choose from: {', '.join(VALID_ROLES)}")
        return

    mongo_uri = _gateway_mongo_uri()
    if not mongo_uri:
        error("GATEWAY_MONGODB_URI not set — check gateway/.env")
        return

    import shutil
    if not shutil.which("bun"):
        error("bun not found — install with: curl -fsSL https://bun.sh/install | bash")
        return

    script = f"""
import {{ MongoClient }} from "mongodb";
const client = new MongoClient({json.dumps(mongo_uri)});
await client.connect();
const col = client.db("llm-gateway").collection("validated_users");
const result = await col.updateOne(
  {{ email: {json.dumps(email.lower())} }},
  {{
    $set:       {{ role: {json.dumps(role)} }},
    $setOnInsert: {{ email: {json.dumps(email.lower())}, createdAt: new Date() }},
  }},
  {{ upsert: true }},
);
await client.close();
console.log(JSON.stringify({{ matched: result.matchedCount, upserted: result.upsertedCount }}));
"""
    result = _run_mongo_script(script)
    if result.returncode != 0:
        error(f"Failed to update role:\n{result.stderr or result.stdout}")
        return

    try:
        out = json.loads(result.stdout.strip())
        action = "created" if out.get("upserted") else "updated"
        info(f"{action} {email} → [bold]{role}[/]")
    except Exception:
        # stdout contained something unexpected but exit code was 0
        info(f"Set {email} → {role}")


def gateway_user_list() -> None:
    """List all gateway users and their roles."""
    load_env()
    mongo_uri = _gateway_mongo_uri()
    if not mongo_uri:
        error("GATEWAY_MONGODB_URI not set — check gateway/.env")
        return

    import shutil
    if not shutil.which("bun"):
        error("bun not found")
        return

    script = f"""
import {{ MongoClient }} from "mongodb";
const client = new MongoClient({json.dumps(mongo_uri)});
await client.connect();
const users = await client.db("llm-gateway").collection("validated_users")
  .find({{}}, {{ projection: {{ email: 1, role: 1, _id: 0 }} }})
  .sort({{ role: 1, email: 1 }})
  .toArray();
await client.close();
console.log(JSON.stringify(users));
"""
    result = _run_mongo_script(script)
    if result.returncode != 0:
        error(f"Failed to list users:\n{result.stderr or result.stdout}")
        return

    try:
        users = json.loads(result.stdout.strip())
    except Exception:
        error(f"Unexpected output: {result.stdout}")
        return

    if not users:
        info("No users found")
        return

    role_color = {"admin": "red", "user": "green", "guest": "yellow"}
    console.print(f"\n  {'EMAIL':<40} ROLE")
    console.print(f"  {'─'*40} ────")
    for u in users:
        r = u.get("role", "?")
        color = role_color.get(r, "white")
        console.print(f"  {u['email']:<40} [{color}]{r}[/]")
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
    """Convert API path to command segments: /api/stats/global → ['stats','global']."""
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
        gateway api health
        gateway api stats global
        gateway api admin users
        gateway api admin approve email=user@example.com
        gateway api keys delete abc123
        gateway api search q=hello
    """
    load_env()

    if not args:
        error("Usage: litellmctl gateway api <command...> [-d json] [key=val...]")
        info("Run: litellmctl gateway routes")
        return

    if not gateway_is_running():
        error("Gateway not running — litellmctl gateway start")
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
        info("Run: litellmctl gateway routes")
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
    console.print("  [dim]Usage: litellmctl gateway api <command...> [-d json] [key=val...][/]\n")


def cmd_gateway(subcmd: str = "status") -> None:
    load_env()
    if subcmd == "start":
        gateway_start()
    elif subcmd == "stop":
        gateway_stop()
    elif subcmd == "restart":
        gateway_stop()
        _ensure_bun_path()
        gateway_dir = PROJECT_DIR / "gateway"
        info("Building gateway frontend ...")
        ret = subprocess.call(["bun", "run", "build"], cwd=str(gateway_dir))
        if ret != 0:
            warn("Frontend build failed — starting anyway")
        gateway_start()
    elif subcmd == "status":
        gateway_status()
    elif subcmd == "logs":
        logfile = LOG_DIR / "gateway.log"
        if not logfile.exists():
            warn("No gateway log file found")
            return
        info("Tailing gateway logs (Ctrl+C to stop)")
        try:
            subprocess.call(["tail", "-f", str(logfile)])
        except KeyboardInterrupt:
            pass
    elif subcmd == "routes":
        gateway_routes()
    else:
        error(f"Unknown gateway subcommand: {subcmd}")
        console.print("  Usage: litellmctl gateway [start|stop|restart|status|logs|routes|api]")
