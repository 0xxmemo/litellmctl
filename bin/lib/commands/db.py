"""Database management — PostgreSQL setup, migrations, status."""

from __future__ import annotations

import os
import shutil
import subprocess
from urllib.parse import urlparse

from ..common.paths import PROJECT_DIR, LOG_DIR, VENV_DIR
from ..common.env import load_env, upsert_env_var, patch_db_flags, remove_db_env_config
from ..common.formatting import console, info, warn
from ..common.platform import is_macos, is_linux, run_with_sudo


def append_linux_socket_host_param(url: str) -> str:
    if not is_linux():
        return url
    if "host=" in url:
        return url
    if "?" in url:
        return f"{url}&host=%2Fvar%2Frun%2Fpostgresql"
    return f"{url}?host=%2Fvar%2Frun%2Fpostgresql"


def db_name_from_url(url: str = "") -> str:
    db_url = url or os.environ.get("DATABASE_URL", "")
    if not db_url:
        return "litellm"
    try:
        parsed = urlparse(db_url)
        name = (parsed.path.lstrip("/") or "litellm").split("?")[0]
        return name
    except Exception:
        return "litellm"


def db_user_from_url(url: str = "") -> str:
    db_url = url or os.environ.get("DATABASE_URL", "")
    default_user = os.environ.get("PGUSER", os.environ.get("USER", "postgres"))
    if not db_url:
        return default_user
    try:
        parsed = urlparse(db_url)
        return parsed.username or default_user
    except Exception:
        return default_user


def db_is_ready() -> bool:
    db_url = os.environ.get("DATABASE_URL", "")
    if not db_url:
        return False
    if not shutil.which("psql"):
        return False
    if subprocess.call(["pg_isready", "-q"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) != 0:
        return False
    return subprocess.call(
        ["psql", db_url, "-qc", 'SELECT 1 FROM "LiteLLM_SpendLogs" LIMIT 0'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ) == 0


def db_status() -> None:
    db_url = os.environ.get("DATABASE_URL", "")
    console.print("[bold]Database[/]")
    if not db_url:
        console.print("  [yellow]Not configured[/]\n")
        return
    console.print(f"  URL: {db_url}")
    if not shutil.which("psql"):
        console.print("  Status: [yellow]psql not found[/]\n")
        return
    if subprocess.call(["pg_isready", "-q"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) != 0:
        console.print("  Status: [red]PostgreSQL not running[/]\n")
        return
    if subprocess.call(
        ["psql", db_url, "-qc", 'SELECT 1 FROM "LiteLLM_SpendLogs" LIMIT 0'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ) == 0:
        console.print("  Status: [green]ready[/]")
    elif subprocess.call(
        ["psql", db_url, "-c", r"\q"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ) == 0:
        console.print("  Status: [yellow]connected, migrations pending[/]")
    else:
        console.print("  Status: [red]cannot connect[/]")
    console.print()


def _ensure_postgres_tools() -> bool:
    if shutil.which("psql"):
        return True
    if is_macos():
        if not shutil.which("brew"):
            return False
        info("Installing PostgreSQL via Homebrew ...")
        ret = subprocess.call(["brew", "install", "postgresql@14"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if ret != 0:
            subprocess.call(["brew", "install", "postgresql"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return shutil.which("psql") is not None
    if is_linux():
        info("Installing PostgreSQL dependencies ...")
        if shutil.which("apt-get"):
            run_with_sudo("apt-get", "update", "-qq")
            run_with_sudo("apt-get", "install", "-y", "-qq", "postgresql", "postgresql-client")
        elif shutil.which("dnf"):
            run_with_sudo("dnf", "install", "-y", "-q", "postgresql", "postgresql-server")
        elif shutil.which("pacman"):
            run_with_sudo("pacman", "-S", "--noconfirm", "--needed", "postgresql")
        elif shutil.which("apk"):
            run_with_sudo("apk", "add", "--quiet", "postgresql", "postgresql-client")
        else:
            return False
        return shutil.which("psql") is not None
    return False


def _pg_start_brew() -> bool:
    if not is_macos() or not shutil.which("brew"):
        return False
    ret = subprocess.call(["brew", "services", "start", "postgresql@14"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if ret != 0:
        subprocess.call(["brew", "services", "start", "postgresql"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(12):
        if subprocess.call(["pg_isready", "-q"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0:
            return True
        import time
        time.sleep(1)
    return subprocess.call(["pg_isready", "-q"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0


def _pg_start_linux() -> bool:
    if not is_linux():
        return False
    if shutil.which("pg_ctlcluster"):
        for v in [17, 16, 15, 14, 13, 12]:
            subprocess.call(["pg_ctlcluster", str(v), "main", "start"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if shutil.which("systemctl"):
        subprocess.call(["systemctl", "start", "postgresql"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elif shutil.which("service"):
        subprocess.call(["service", "postgresql", "start"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    import time
    for _ in range(20):
        if subprocess.call(["pg_isready", "-q"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0:
            return True
        time.sleep(1)
    return subprocess.call(["pg_isready", "-q"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0


def _pg_start_local() -> bool:
    return _pg_start_brew() or _pg_start_linux()


def _linux_bootstrap_role_and_db(db_user: str, db_name: str) -> bool:
    if not is_linux():
        return False
    import re
    if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', db_user):
        return False
    if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', db_name):
        return False

    info("Attempting PostgreSQL bootstrap via postgres superuser ...")
    result = subprocess.run(
        ["sudo", "-u", "postgres", "psql", "-tAc",
         f"SELECT 1 FROM pg_roles WHERE rolname='{db_user}'"],
        capture_output=True, text=True,
    )
    if "1" not in result.stdout:
        subprocess.call(["sudo", "-u", "postgres", "createuser", "--createdb", db_user],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        subprocess.call(
            ["sudo", "-u", "postgres", "psql", "-d", "postgres", "-c",
             f'ALTER ROLE "{db_user}" CREATEDB;'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )

    subprocess.call(["sudo", "-u", "postgres", "createdb", "-O", db_user, db_name],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # Repair permissions
    for sql in [
        f'GRANT ALL ON SCHEMA public TO "{db_user}";',
        f'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "{db_user}";',
        f'GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "{db_user}";',
        f'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "{db_user}";',
        f'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "{db_user}";',
    ]:
        subprocess.call(["sudo", "-u", "postgres", "psql", "-d", db_name, "-c", sql],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    result = subprocess.run(["psql", "-lqt"], capture_output=True, text=True)
    return db_name in result.stdout


def _resolve_proxy_prisma_schema() -> str | None:
    try:
        result = subprocess.run(
            ["python3", "-c", """
import importlib.util
from pathlib import Path
spec = importlib.util.find_spec("litellm_proxy_extras")
if not spec or not spec.origin:
    raise SystemExit(1)
root = Path(spec.origin).resolve().parent
schema = root / "schema.prisma"
if schema.exists():
    print(schema)
"""],
            capture_output=True, text=True,
        )
        path = result.stdout.strip()
        return path if path else None
    except Exception:
        return None


def _ensure_prisma_installed() -> bool:
    ret = subprocess.call(
        ["python3", "-c", "import prisma"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if ret == 0:
        return True
    info("Installing missing prisma dependency for DB migrations ...")
    return subprocess.call(["pip", "install", "--quiet", "prisma"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0


def _ensure_prisma_generated() -> bool:
    prisma_dir = PROJECT_DIR / "litellm" / "litellm" / "proxy"
    schema = prisma_dir / "schema.prisma"
    if not schema.exists():
        return False
    if not shutil.which("prisma"):
        return False
    return subprocess.call(
        ["bash", "-c", f"cd {prisma_dir} && prisma generate && prisma py generate"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ) == 0


def _run_db_migrations(parsed_db: str) -> bool:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    mig_log = LOG_DIR / "db-migrate.log"
    mig_log.write_text("")

    schema = _resolve_proxy_prisma_schema()
    if schema and shutil.which("prisma"):
        with open(mig_log, "a") as log:
            subprocess.call(
                ["prisma", "migrate", "deploy", "--schema", schema],
                stdout=log, stderr=log,
            )

    with open(mig_log, "a") as log:
        subprocess.call(
            ["litellm", "--config", str(PROJECT_DIR / "config.yaml"), "--skip_server_startup"],
            stdout=log, stderr=log,
        )

    db_url = os.environ.get("DATABASE_URL", "")
    if subprocess.call(
        ["psql", db_url, "-qc", 'SELECT 1 FROM "LiteLLM_SpendLogs" LIMIT 0'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ) == 0:
        return True

    warn("Database migrations are still pending.")
    warn("Recent migration output:")
    subprocess.call(["tail", "-n", "25", str(mig_log)])
    return False


def ensure_db_ready() -> bool:
    """Called during install when DB setup is enabled. Idempotent."""
    env_file = PROJECT_DIR / ".env"
    db_name = "litellm"
    db_user = os.environ.get("PGUSER", os.environ.get("USER", "postgres"))
    default_url = f"postgresql://{db_user}@localhost/{db_name}"
    if is_linux():
        default_url = append_linux_socket_host_param(default_url)

    if not _ensure_postgres_tools():
        warn("PostgreSQL dependencies are missing and could not be auto-installed.")
        warn("Skipping DB setup for now.")
        return True

    if not env_file.exists():
        if (PROJECT_DIR / ".env.example").exists():
            import shutil as sh
            sh.copy2(PROJECT_DIR / ".env.example", env_file)
            warn("Created .env from .env.example — fill in your API keys.")
        else:
            env_file.touch()

    text = env_file.read_text()
    if "DATABASE_URL=" not in text:
        if shutil.which("psql"):
            info("Configuring local database (DATABASE_URL) ...")
            with env_file.open("a") as f:
                f.write(f"\nDATABASE_URL={default_url}\n")
            load_env()
        else:
            warn("PostgreSQL client (psql) not found — skipping DB setup.")
            return True

    if "DISABLE_SCHEMA_UPDATE=" not in env_file.read_text():
        info("Setting DISABLE_SCHEMA_UPDATE=true (recommended for stable startup) ...")
        with env_file.open("a") as f:
            f.write("\nDISABLE_SCHEMA_UPDATE=true\n")
        load_env()

    if subprocess.call(["pg_isready", "-q"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) != 0:
        if not _pg_start_local():
            warn("PostgreSQL not running and could not start it — skipping DB setup.")
            return True

    db_url = os.environ.get("DATABASE_URL", default_url)
    parsed_db = db_name_from_url(db_url)

    result = subprocess.run(["psql", "-lqt"], capture_output=True, text=True)
    if parsed_db not in result.stdout:
        info(f"Creating database '{parsed_db}' ...")
        if subprocess.call(["createdb", parsed_db],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) != 0:
            if not _linux_bootstrap_role_and_db(db_user, parsed_db):
                warn(f"Could not create database '{parsed_db}' — skipping DB setup.")
                return True

    if subprocess.call(
        ["psql", db_url, "-qc", 'SELECT 1 FROM "LiteLLM_SpendLogs" LIMIT 0'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ) != 0:
        if not _ensure_prisma_installed():
            warn("Prisma dependency missing — skipping DB migrations.")
            return True
        if not _ensure_prisma_generated():
            warn("Prisma client generation failed — skipping DB migrations.")
            return True
        info("Running database migrations ...")
        os.environ["DATABASE_URL"] = db_url
        if not _run_db_migrations(parsed_db):
            warn("Migration command failed on first attempt; retrying after permission repair ...")
            if is_linux():
                _linux_bootstrap_role_and_db(db_user, parsed_db)
            if not _run_db_migrations(parsed_db):
                return False
        info("Database ready.")

    patch_db_flags()
    return True
