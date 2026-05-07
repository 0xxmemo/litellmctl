"""Lazy dependency helpers — fail gracefully with actionable messages."""

from __future__ import annotations


def require_questionary():
    """Import and return the questionary module, or exit with install instructions."""
    try:
        import questionary
        return questionary
    except ModuleNotFoundError:
        from .formatting import error
        from .paths import PROJECT_DIR, VENV_DIR

        error("Missing dependency: questionary (interactive prompts)")
        pip_exe = VENV_DIR / "bin" / "pip"
        if pip_exe.is_file():
            error(f"Run:  {pip_exe} install questionary typer rich")
        else:
            error("Run:  bash install.sh   from your checkout")
            error(f"(Creates venv + deps under {PROJECT_DIR})")
        raise SystemExit(1)
