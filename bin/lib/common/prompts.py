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
    """Pick multiple items in order using checkboxes. Returns list of 0-based indices.

    Users select/deselect with spacebar. Order is determined by selection sequence.
    Deselecting removes the item from order. Press Enter when done.
    """
    from prompt_toolkit import Application
    from prompt_toolkit.key_binding import KeyBindings
    from prompt_toolkit.layout.containers import HSplit
    from prompt_toolkit.layout.layout import Layout
    from prompt_toolkit.widgets import CheckboxList

    q = require_questionary()

    # Track selection order: list of indices in order they were selected
    selection_order: list[int] = []
    # Track previous selection state to detect changes
    _prev_values: list = []

    def make_values() -> list:
        """Build (value, label) tuples with order prefix for selected items."""
        result = []
        for i, choice in enumerate(choices):
            # Check if this index is in the current selection_order
            if i in selection_order:
                order_num = selection_order.index(i) + 1
                result.append((i, f"[{order_num}] {choice}"))
            else:
                result.append((i, f"    {choice}"))
        return result

    def update_order(cl: CheckboxList) -> None:
        """Update selection_order based on current_values changes."""
        nonlocal _prev_values
        current_vals = cl.current_values.copy()

        # Detect what changed
        prev_set = set(_prev_values)
        curr_set = set(current_vals)

        added = curr_set - prev_set
        removed = prev_set - curr_set

        # Update order: remove deselected, add newly selected at end
        for idx in removed:
            if idx in selection_order:
                selection_order.remove(idx)
        for idx in added:
            selection_order.append(idx)

        _prev_values = current_vals
        # Update display with order numbers
        cl.values = make_values()

    # Initial values - use indices as both value and track in current_values
    initial_values = [(i, f"    {c}") for i, c in enumerate(choices)]
    checkbox_list = CheckboxList(values=initial_values)
    _prev_values = []  # Start with nothing selected

    # Patch _handle_enter to update display after toggle
    _original_handle_enter = checkbox_list._handle_enter

    def _patched_handle_enter() -> None:
        _original_handle_enter()
        update_order(checkbox_list)

    checkbox_list._handle_enter = _patched_handle_enter

    # Remove Enter key binding from widget so it doesn't toggle
    from prompt_toolkit.keys import Keys
    widget_kb = checkbox_list.control.key_bindings
    widget_kb.remove(Keys.Enter)

    kb = KeyBindings()

    @kb.add("enter")
    def _done(event):
        """Exit and return the selection order."""
        event.app.exit(result=selection_order.copy())

    @kb.add("c-c")
    def _interrupt(event):
        """Handle Ctrl+C gracefully."""
        event.app.exit(exception=KeyboardInterrupt())

    container = HSplit([checkbox_list])
    layout = Layout(container)

    application = Application(
        layout=layout,
        key_bindings=kb,
        full_screen=False,
        mouse_support=True,
        style=q.Style([
            ("checkbox", "fg:cyan"),
            ("checkbox-selected", "fg:green bold"),
            ("pointer", "bg:cyan fg:white"),
        ]),
    )

    result = application.run()
    if result is None:
        raise KeyboardInterrupt
    if not result:
        return list(range(len(choices)))  # default: all
    return result


def choice(label: str, **kwargs):
    """Create a questionary Choice."""
    q = require_questionary()
    return q.Choice(label, **kwargs)


def separator(label: str = ""):
    """Create a questionary Separator."""
    q = require_questionary()
    return q.Separator(label)
