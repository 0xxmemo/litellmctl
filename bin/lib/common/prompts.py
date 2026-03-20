"""Shared questionary prompt utilities — single source for styles and helpers."""

from __future__ import annotations

from typing import Any

from .deps import require_questionary


def style():
    """Shared style for all questionary prompts."""
    q = require_questionary()
    return q.Style([
        ("qmark", "fg:cyan bold"),
        ("question", "bold"),
        ("answer", "fg:green bold"),
        ("pointer", "fg:cyan bold"),
        ("highlighted", "fg:cyan bold"),
        ("selected", "fg:green noreverse"),
    ])


def _checkbox_style():
    """Checkbox style where checked state is clear without background highlight.

    prompt_toolkit's built-in default applies 'reverse' to class:selected,
    which causes a green background bar on checked rows. Adding 'noreverse'
    cancels that so only the text color changes.
    """
    q = require_questionary()
    return q.Style([
        ("qmark", "fg:cyan bold"),
        ("question", "bold"),
        ("answer", "fg:green bold"),
        ("pointer", "fg:cyan bold"),
        ("highlighted", ""),
        ("selected", "fg:green noreverse"),
    ])


def ask(prompt: str, default: str = "") -> str:
    """Single-line text input."""
    q = require_questionary()
    return q.text(prompt, default=default, style=style()).ask() or default


def confirm(prompt: str, default: bool = True) -> bool:
    """Yes/no confirmation."""
    q = require_questionary()
    result = q.confirm(prompt, default=default, style=style()).ask()
    if result is None:
        raise KeyboardInterrupt
    return result


def select(prompt: str, choices: list, **kwargs) -> Any:
    """Single-select menu."""
    q = require_questionary()
    kwargs.setdefault("style", style())
    return q.select(prompt, choices=choices, **kwargs).ask()


def checkbox(prompt: str, choices: list, **kwargs) -> list:
    """Multi-select checkbox."""
    q = require_questionary()
    kwargs.setdefault("style", _checkbox_style())
    result = q.checkbox(prompt, choices=choices, **kwargs).ask()
    if result is None:
        raise KeyboardInterrupt
    return result


def pick_one(prompt: str, choices: list[str], default: str | None = None) -> int:
    """Pick one item. Returns 0-based index."""
    result = select(prompt, choices, default=default)
    if result is None:
        raise KeyboardInterrupt
    return choices.index(result)


def pick_many(prompt: str, choices: list[str]) -> list[int]:
    """Pick multiple items. Returns list of 0-based indices."""
    result = checkbox(prompt, choices=choices)
    if not result:
        return list(range(len(choices)))  # default: all
    return [choices.index(r) for r in result]


def choice(label: str, **kwargs):
    """Create a questionary Choice."""
    q = require_questionary()
    return q.Choice(label, **kwargs)


def separator(label: str = ""):
    """Create a questionary Separator."""
    q = require_questionary()
    return q.Separator(label)
