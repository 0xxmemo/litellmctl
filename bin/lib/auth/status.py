"""Auth status display."""

from __future__ import annotations

import json

from ..common.formatting import console
from .core import _show_token
from .chatgpt import _chatgpt_auth_file
from .gemini import _gemini_auth_file
from .qwen import _qwen_auth_file
from .kimi import _kimi_auth_file


def show_status():
    console.print()
    console.print("[bold]LiteLLM Auth Status[/]")
    console.print("[dim]" + "═" * 40 + "[/]")

    for label, getter in [
        ("ChatGPT / Codex", _chatgpt_auth_file),
        ("Gemini CLI", _gemini_auth_file),
        ("Qwen Portal", _qwen_auth_file),
        ("Kimi Code", _kimi_auth_file),
    ]:
        f = getter()
        console.print(f"\n[bold]{label}[/]")
        console.print(f"  File: {f}")
        if f.exists():
            try:
                _show_token(label, json.loads(f.read_text()))
            except Exception as e:
                console.print(f"[red]  Error: {e}\n[/]")
        else:
            console.print("[yellow]  Not authenticated\n[/]")
