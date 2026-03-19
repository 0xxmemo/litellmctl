"""Lazy dependency helpers — fail gracefully with actionable messages."""

from __future__ import annotations


def require_questionary():
    """Import and return the questionary module, or exit with install instructions."""
    try:
        import questionary
        return questionary
    except ModuleNotFoundError:
        from .formatting import error
        error("Missing dependency: questionary")
        error("Run:  pip install questionary   (inside the litellm venv)")
        raise SystemExit(1)
