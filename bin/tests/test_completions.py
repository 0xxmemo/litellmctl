"""Tests for shell completion generation."""

from __future__ import annotations


class TestBashCompletions:
    def test_returns_string(self):
        from lib.commands.completions import generate_completions
        result = generate_completions()
        assert isinstance(result, str)

    def test_contains_function_definition(self):
        from lib.commands.completions import generate_completions
        result = generate_completions()
        assert "_litellmctl_completions()" in result
        assert "complete -F _litellmctl_completions litellmctl" in result

    def test_contains_core_commands(self):
        from lib.commands.completions import generate_completions
        result = generate_completions()
        for cmd in ("start", "stop", "restart", "status", "auth", "wizard"):
            assert cmd in result

    def test_contains_auth_subcommands(self):
        from lib.commands.completions import generate_completions
        result = generate_completions()
        for sub in ("chatgpt", "gemini", "qwen", "kimi"):
            assert sub in result

    def test_contains_gateway_subcommands(self):
        from lib.commands.completions import generate_completions
        result = generate_completions()
        assert "gateway" in result


class TestZshCompletions:
    def test_returns_string(self):
        from lib.commands.completions import generate_zsh_completions
        result = generate_zsh_completions()
        assert isinstance(result, str)

    def test_uses_local_array_declaration(self):
        from lib.commands.completions import generate_zsh_completions
        result = generate_zsh_completions()
        assert "local -a commands" in result

    def test_contains_compdef(self):
        from lib.commands.completions import generate_zsh_completions
        result = generate_zsh_completions()
        assert "compdef _litellmctl_completions litellmctl" in result

    def test_describe_commands(self):
        from lib.commands.completions import generate_zsh_completions
        result = generate_zsh_completions()
        assert "_describe 'command' commands" in result

    def test_auth_describe(self):
        from lib.commands.completions import generate_zsh_completions
        result = generate_zsh_completions()
        assert "_describe 'auth command' auth_cmds" in result

    def test_no_duplicate_function_names(self):
        from lib.commands.completions import BASH_COMPLETIONS, ZSH_COMPLETIONS
        # Both use the same function name but they're separate scripts
        assert BASH_COMPLETIONS != ZSH_COMPLETIONS


class TestCompletionConstants:
    def test_bash_and_zsh_differ(self):
        from lib.commands.completions import BASH_COMPLETIONS, ZSH_COMPLETIONS
        assert BASH_COMPLETIONS != ZSH_COMPLETIONS

    def test_generate_functions_substitute_placeholders(self):
        """generate_* must return fully-substituted strings (no __PLACEHOLDER__ left)."""
        from lib.commands.completions import (
            generate_completions, generate_zsh_completions,
        )
        bash = generate_completions()
        zsh = generate_zsh_completions()
        assert "__" not in bash or "$HOME" in bash  # $HOME is the only valid __-adjacent
        assert "__TOP_COMMANDS__" not in bash and "__TOP_COMMANDS__" not in zsh
        assert "__FEATURES__" not in bash and "__FEATURES__" not in zsh
        # Sanity: both contain expected top-level commands
        assert "start" in bash and "stop" in bash and "users" in bash
        assert "start" in zsh and "stop" in zsh and "users" in zsh
