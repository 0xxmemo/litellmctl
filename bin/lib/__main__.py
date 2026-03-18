"""Entry point for python3 -m lib."""

from __future__ import annotations

import sys


def main() -> None:
    # Handle --completions / --zsh-completions specially (prints shell code)
    if len(sys.argv) > 1:
        if sys.argv[1] == "--completions":
            from .commands.completions import generate_completions
            print(generate_completions())
            return
        if sys.argv[1] == "--zsh-completions":
            from .commands.completions import generate_zsh_completions
            print(generate_zsh_completions())
            return

    # No args + TTY -> interactive menu
    if len(sys.argv) <= 1 and sys.stdin.isatty():
        from .interactive import interactive_menu
        try:
            interactive_menu()
        except KeyboardInterrupt:
            from .common.formatting import info
            info("Goodbye.")
        return

    # Otherwise, use Typer CLI
    from .cli import app
    app()


if __name__ == "__main__":
    main()
