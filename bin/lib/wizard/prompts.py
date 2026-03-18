"""Questionary-based interactive prompts for the wizard."""

from __future__ import annotations

import questionary
from questionary import Style

WIZARD_STYLE = Style([
    ("qmark", "fg:cyan bold"),
    ("question", "bold"),
    ("answer", "fg:green bold"),
    ("pointer", "fg:cyan bold"),
    ("highlighted", "fg:cyan bold"),
    ("selected", "fg:green"),
])


def ask(prompt: str, default: str = "") -> str:
    return questionary.text(prompt, default=default, style=WIZARD_STYLE).ask() or default


def confirm(prompt: str, default: bool = True) -> bool:
    result = questionary.confirm(prompt, default=default, style=WIZARD_STYLE).ask()
    if result is None:
        raise KeyboardInterrupt
    return result


def pick_one(prompt: str, choices: list[str], default: str | None = None) -> int:
    """Pick one item. Returns 0-based index."""
    result = questionary.select(
        prompt, choices=choices, default=default, style=WIZARD_STYLE,
    ).ask()
    if result is None:
        raise KeyboardInterrupt
    return choices.index(result)


def pick_many(prompt: str, choices: list[str]) -> list[int]:
    """Pick multiple items. Returns list of 0-based indices."""
    result = questionary.checkbox(
        prompt, choices=choices, style=WIZARD_STYLE,
    ).ask()
    if result is None:
        raise KeyboardInterrupt
    if not result:
        return list(range(len(choices)))  # default: all
    return [choices.index(r) for r in result]
