"""Update command — git pull (parent + submodule), reinstall venv, restart proxy.

Mirrors what users used to do by hand on EC2:

    cd ~/.litellm && git pull
    cd litellm && git pull
    venv/bin/pip install -e "../litellm[proxy]" --no-deps
    litellmctl restart proxy

`litellmctl restart proxy` alone does NOT pick up changes when the editable
install was overwritten or when a non-editable copy is shadowing the
submodule, so we always reinstall the editable package as part of update.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from ..common.formatting import console, error, info, warn
from ..common.paths import PROJECT_DIR, VENV_DIR


def _git(args: list[str], cwd: Path) -> tuple[int, str]:
    """Run a git command in ``cwd`` and return (returncode, stdout+stderr)."""
    result = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
    )
    return result.returncode, (result.stdout or "") + (result.stderr or "")


def _git_head(cwd: Path) -> str:
    rc, out = _git(["rev-parse", "HEAD"], cwd)
    return out.strip() if rc == 0 else ""


def _git_pull(cwd: Path, label: str) -> bool:
    """Run `git pull --ff-only` in cwd. Return True if the head moved."""
    pre = _git_head(cwd)
    info(f"git pull ({label}) ...")
    rc, out = _git(["pull", "--ff-only"], cwd)
    if rc != 0:
        warn(f"git pull failed in {cwd}:")
        console.print(out.strip())
        return False
    post = _git_head(cwd)
    if pre and post and pre != post:
        info(f"  {label}: {pre[:10]} → {post[:10]}")
        return True
    info(f"  {label}: already up to date")
    return False


def _purge_pycache(root: Path) -> int:
    """Remove every __pycache__ directory under ``root``. Returns count."""
    n = 0
    for p in root.rglob("__pycache__"):
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
            n += 1
    return n


def cmd_update(*, skip_restart: bool = False, force: bool = False) -> None:
    """Pull latest, reinstall the editable litellm fork, restart the proxy.

    Args:
        skip_restart: If True, don't restart proxy after reinstall (CI / debugging).
        force: Reinstall even when both git pulls report "already up to date".
    """
    submodule_dir = PROJECT_DIR / "litellm"
    if not (submodule_dir / ".git").exists() and not (submodule_dir / "pyproject.toml").exists():
        error(f"litellm submodule not found at {submodule_dir}")
        error("Run 'litellmctl install' first.")
        return

    parent_changed = _git_pull(PROJECT_DIR, "parent repo")
    submodule_changed = _git_pull(submodule_dir, "litellm submodule")

    # Make sure the submodule pointer recorded in the parent matches what's
    # actually checked out — parent pulls move the pointer; sync brings the
    # working tree in line.
    rc, out = _git(["submodule", "update", "--init", "--recursive"], PROJECT_DIR)
    if rc != 0:
        warn("git submodule update failed:")
        console.print(out.strip())

    if not (parent_changed or submodule_changed or force):
        info("Nothing to update.")
        if not skip_restart:
            info("Pass --force to reinstall + restart anyway.")
        return

    # Drop stale .pyc caches under the submodule so a process restart can't
    # ride an old compiled module from a previous deploy.
    purged = _purge_pycache(submodule_dir)
    if purged:
        info(f"Cleared {purged} __pycache__ dir(s) under {submodule_dir}")

    pip = VENV_DIR / "bin" / "pip"
    if not pip.exists():
        error(f"venv pip not found at {pip}. Run 'litellmctl install' first.")
        return

    info("Reinstalling editable litellm fork ...")
    rc = subprocess.call(
        [
            str(pip),
            "install",
            "-e",
            f"{submodule_dir}[proxy]",
            "--no-deps",
            "--quiet",
        ]
    )
    if rc != 0:
        error(f"pip install failed (exit {rc}). Aborting before restart.")
        return

    if skip_restart:
        info("Update complete. Skipping proxy restart (--skip-restart).")
        info("Run 'litellmctl restart proxy' when you're ready.")
        return

    info("Restarting proxy ...")
    from .service import cmd_restart
    cmd_restart()
