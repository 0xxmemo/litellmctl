"""Rich-based console output — replaces all ANSI color helpers."""

from __future__ import annotations

import sys
from rich.console import Console

console = Console(stderr=True)

_TTY = sys.stdout.isatty()

# Symbols
TICK = "[green]✓[/]" if _TTY else "[ok]"
CROSS = "[red]✗[/]" if _TTY else "[--]"
WARN_SYM = "[yellow]⚠[/]" if _TTY else "[!!]"
ARROW = "[cyan]→[/]" if _TTY else "->"
BAR = "[dim]" + "─" * 56 + "[/]"


def info(msg: str) -> None:
    """Blue info message."""
    console.print(f"[bold blue]==> {msg}[/]")


def warn(msg: str) -> None:
    """Yellow warning message."""
    console.print(f"[bold yellow]==> {msg}[/]")


def error(msg: str) -> None:
    """Red error message to stderr."""
    console.print(f"[bold red]==> {msg}[/]", style="bold red")


def header(text: str) -> None:
    """Bold header with separator."""
    console.print(f"\n[bold]{text}[/]")
    console.print(BAR)


def step(num: int, text: str) -> None:
    """Numbered step header."""
    console.print(f"\n[bold]Step {num}:[/] {text}")
    console.print(BAR)


def dim(text: str) -> str:
    """Return dim-styled string for Rich."""
    return f"[dim]{text}[/]"
