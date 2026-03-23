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


def pick_ordered(prompt: str, choices: list[str]) -> list[int]:
    """Pick multiple items in order. Returns list of 0-based indices.

    Displays choices with numbered prefix (1. 2. 3. ...) for clarity
    when the selection order matters (e.g., fallback priority).
    """
    # Prepend numbers to choices for display
    numbered_choices = [f"{i + 1}. {choice}" for i, choice in enumerate(choices)]
    result = checkbox(prompt, choices=numbered_choices)
    if not result:
        return list(range(len(choices)))  # default: all
    # Extract original index from numbered choice
    indices = []
    for r in result:
        # Parse "1. choice text" -> index 0
        num_str = r.split(". ")[0]
        indices.append(int(num_str) - 1)
    return indices


def choice(label: str, **kwargs):
    """Create a questionary Choice."""
    q = require_questionary()
    return q.Choice(label, **kwargs)


def separator(label: str = ""):
    """Create a questionary Separator."""
    q = require_questionary()
    return q.Separator(label)
