"""ProtonMail bridge (hydroxide) management."""

from __future__ import annotations

import os
import shutil
import subprocess

from ..common.paths import LOG_DIR
from ..common.formatting import console, info, warn
from ..common.platform import is_macos, is_linux
from ..common.network import port_in_use


def install_protonmail() -> bool:
    if shutil.which("hydroxide"):
        info("hydroxide already installed")
    else:
        info("Installing hydroxide (ProtonMail SMTP bridge) ...")
        if not shutil.which("go"):
            info("Go not found — installing ...")
            if is_macos() and shutil.which("brew"):
                if subprocess.call(["brew", "install", "go"]) != 0:
                    warn("brew install go failed")
                    return False
            elif is_linux():
                if shutil.which("apt-get"):
                    subprocess.call(["sudo", "apt-get", "update", "-qq"])
                    subprocess.call(["sudo", "apt-get", "install", "-y", "-qq", "golang-go"])
                elif shutil.which("dnf"):
                    subprocess.call(["sudo", "dnf", "install", "-y", "golang"])
                elif shutil.which("pacman"):
                    subprocess.call(["sudo", "pacman", "-S", "--noconfirm", "go"])
                else:
                    warn("Install Go manually: https://go.dev/dl/")
                    return False
            else:
                warn("Install Go manually: https://go.dev/dl/")
                return False

        ret = subprocess.call(
            ["go", "install", "github.com/emersion/hydroxide/cmd/hydroxide@latest"],
        )
        if ret != 0:
            warn("hydroxide install failed")
            return False
        os.environ["PATH"] = f"{os.path.expanduser('~/go/bin')}:{os.environ.get('PATH', '')}"

    if not shutil.which("hydroxide"):
        os.environ["PATH"] = f"{os.path.expanduser('~/go/bin')}:{os.environ.get('PATH', '')}"
    if not shutil.which("hydroxide"):
        warn("hydroxide not found in PATH after install")
        return False

    info(f"hydroxide installed at {shutil.which('hydroxide')}")

    auth_dir = os.path.expanduser("~/.config/hydroxide")
    if os.path.isdir(auth_dir) and os.listdir(auth_dir):
        info("hydroxide already authenticated")
    else:
        console.print()
        info("hydroxide needs ProtonMail authentication.")
        info("Run the following command and enter your ProtonMail credentials:")
        console.print("\n      hydroxide auth <your-protonmail-username>\n")
        info("After authenticating, set these in your gateway .env:")
        console.print("\n      PROTON_EMAIL=<your-protonmail-email>")
        console.print("      PROTON_PASSWORD=<your-bridge-password>\n")

    if port_in_use(1025):
        info("hydroxide SMTP bridge already running on port 1025")
    else:
        info("Start the SMTP bridge with:")
        console.print("\n      hydroxide smtp\n")
        info("Or run in background:")
        console.print(f"\n      nohup hydroxide smtp > {LOG_DIR}/hydroxide.log 2>&1 &\n")

    return True


def _hydroxide_bin() -> str | None:
    path = shutil.which("hydroxide")
    if not path:
        go_path = os.path.expanduser("~/go/bin/hydroxide")
        if os.path.isfile(go_path) and os.access(go_path, os.X_OK):
            path = go_path
    return path


def _hydroxide_authenticated() -> bool:
    auth_dir = os.path.expanduser("~/.config/hydroxide")
    return os.path.isdir(auth_dir) and bool(os.listdir(auth_dir))


def hydroxide_start() -> bool:
    """Start hydroxide SMTP bridge if installed and authenticated."""
    if port_in_use(1025):
        return True  # already running

    hbin = _hydroxide_bin()
    if not hbin:
        return False

    if not _hydroxide_authenticated():
        username = os.environ.get("GATEWAY_PROTON_USERNAME", "")
        warn("hydroxide is not authenticated.")
        if username:
            info(f"Run: hydroxide auth {username}")
        else:
            info("Run: hydroxide auth <your-protonmail-username>")
        return False

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_f = open(LOG_DIR / "hydroxide.log", "a")
    subprocess.Popen(
        [hbin, "smtp"],
        stdout=log_f, stderr=log_f,
        start_new_session=True,
    )
    import time; time.sleep(1)
    if port_in_use(1025):
        info("hydroxide SMTP bridge started (port 1025)")
        return True
    warn("hydroxide started but not listening on port 1025")
    return False


def hydroxide_stop() -> None:
    """Stop hydroxide SMTP bridge."""
    import signal
    try:
        result = subprocess.run(["pgrep", "-x", "hydroxide"], capture_output=True, text=True)
        for pid_str in result.stdout.strip().splitlines():
            os.kill(int(pid_str), signal.SIGTERM)
        info("hydroxide stopped")
    except Exception:
        info("hydroxide not running")


def protonmail_status() -> None:
    console.print("[bold]ProtonMail Bridge (hydroxide)[/]")

    bin_path = _hydroxide_bin()
    if not bin_path:
        console.print("  Status:   [yellow]not installed[/]")
        console.print("  [dim]Install: litellmctl install --with-protonmail[/]")
        console.print()
        return

    authed = _hydroxide_authenticated()
    if port_in_use(1025):
        console.print("  Status:   [green]running[/]")
        console.print("  Port:     1025 (SMTP)")
        email = os.environ.get("GATEWAY_PROTON_EMAIL", os.environ.get("PROTON_EMAIL", ""))
        if email:
            console.print(f"  Account:  {email}")
    elif not authed:
        console.print("  Status:   [red]not authenticated[/]")
        username = os.environ.get("GATEWAY_PROTON_USERNAME", "<your-username>")
        console.print(f"  [dim]Auth: hydroxide auth {username}[/]")
        console.print(f"  [dim]Then: hydroxide smtp[/]")
    else:
        console.print("  Status:   [yellow]stopped[/]")
        console.print(f"  Binary:   {bin_path}")
        console.print("  [dim]Start: litellmctl protonmail start[/]")

    console.print()


def uninstall_protonmail() -> None:
    console.print("\n  [bold]ProtonMail bridge (hydroxide)[/]")

    if not shutil.which("hydroxide"):
        os.environ["PATH"] = f"{os.path.expanduser('~/go/bin')}:{os.environ.get('PATH', '')}"

    if not shutil.which("hydroxide"):
        console.print("  Not installed.\n")
        return

    if port_in_use(1025):
        console.print("  SMTP bridge running on port 1025. Stop it:\n")
        console.print("      pkill hydroxide\n")
    else:
        console.print("  Not running.\n")

    console.print("  Uninstall:\n")
    console.print("      rm -f $(which hydroxide)")
    console.print("      rm -rf ~/.config/hydroxide\n")


def cmd_protonmail(subcmd: str = "status") -> None:
    from ..common.env import load_env
    load_env()
    if subcmd == "start":
        hydroxide_start()
    elif subcmd == "stop":
        hydroxide_stop()
    elif subcmd == "restart":
        hydroxide_stop()
        import time; time.sleep(1)
        hydroxide_start()
    elif subcmd == "status":
        protonmail_status()
    elif subcmd == "auth":
        username = os.environ.get("GATEWAY_PROTON_USERNAME", "")
        hbin = _hydroxide_bin()
        if not hbin:
            warn("hydroxide not installed. Run: litellmctl install --with-protonmail")
            return
        if username:
            info(f"Run: {hbin} auth {username}")
        else:
            info(f"Run: {hbin} auth <your-protonmail-username>")
        info("After authenticating, run: litellmctl protonmail start")
    else:
        from ..common.formatting import error
        error(f"Unknown subcommand: {subcmd}")
        console.print("  Usage: litellmctl protonmail [start|stop|restart|status|auth]")
