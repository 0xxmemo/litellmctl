"""Questionary-based interactive prompts for the wizard."""

from __future__ import annotations

from ..common.deps import require_questionary


def _style():
    q = require_questionary()
    return q.Style([
        ("qmark", "fg:cyan bold"),
        ("question", "bold"),
        ("answer", "fg:green bold"),
        ("pointer", "fg:cyan bold"),
        ("highlighted", "fg:cyan bold"),
        ("selected", "fg:green"),
    ])


def ask(prompt: str, default: str = "") -> str:
    q = require_questionary()
    return q.text(prompt, default=default, style=_style()).ask() or default


def confirm(prompt: str, default: bool = True) -> bool:
    q = require_questionary()
    result = q.confirm(prompt, default=default, style=_style()).ask()
    if result is None:
        raise KeyboardInterrupt
    return result


def pick_one(prompt: str, choices: list[str], default: str | None = None) -> int:
    """Pick one item. Returns 0-based index."""
    q = require_questionary()
    result = q.select(
        prompt, choices=choices, default=default, style=_style(),
    ).ask()
    if result is None:
        raise KeyboardInterrupt
    return choices.index(result)


def pick_many(prompt: str, choices: list[str]) -> list[int]:
    """Pick multiple items. Returns list of 0-based indices."""
    q = require_questionary()
    result = q.checkbox(
        prompt, choices=choices, style=_style(),
    ).ask()
    if result is None:
        raise KeyboardInterrupt
    if not result:
        return list(range(len(choices)))  # default: all
    return [choices.index(r) for r in result]
