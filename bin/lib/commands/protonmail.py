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
