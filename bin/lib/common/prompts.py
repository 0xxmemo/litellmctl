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
    from prompt_toolkit.layout.containers import Window
    from prompt_toolkit.layout.controls import CheckboxList
    from prompt_toolkit.layout.layout import Layout

    q = require_questionary()

    # Track selection order: list of indices in order they were selected
    selection_order: list[int] = []
    # Track which indices are currently selected
    selected_set: set[int] = set()

    def make_choices() -> list:
        """Build choices with order prefix for selected items."""
        result = []
        for i, choice in enumerate(choices):
            if i in selected_set:
                # Show order number for selected items
                order_num = selection_order.index(i) + 1
                result.append(q.Choice(f"[{order_num}] {choice}", value=i, checked=True))
            else:
                result.append(q.Choice(f"    {choice}", value=i, checked=False))
        return result

    kb = KeyBindings()

    @kb.add("enter")
    def _done(event):
        event.app.exit(result=selection_order.copy())

    @kb.add("space")
    def _toggle(event):
        layout = event.app.layout
        container = layout.current_window
        if container:
            children = container.get_children()
            if children:
                widget = children[0]
                if hasattr(widget, 'current_index'):
                    idx = widget.current_index
                    if idx in selected_set:
                        # Deselect - remove from order
                        selected_set.discard(idx)
                        if idx in selection_order:
                            selection_order.remove(idx)
                    else:
                        # Select - add to end of order
                        selected_set.add(idx)
                        selection_order.append(idx)
                    # Update choices
                    widget.options = make_choices()

    container = Window(content=CheckboxList(choices=make_choices()), height=None)
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
