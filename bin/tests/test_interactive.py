"""Tests for interactive menu with mocked questionary."""

from __future__ import annotations

import unittest.mock as mock
import sys

import pytest

try:
    import questionary
    _questionary_available = True
except ImportError:
    _questionary_available = False

pytestmark = pytest.mark.skipif(
    not _questionary_available, reason="questionary not installed"
)


class TestWizardPrompts:
    """Test questionary wrappers in lib/wizard/prompts.py."""

    def test_ask_calls_questionary_select(self):
        from lib.wizard import prompts as p
        with mock.patch("lib.wizard.prompts.questionary") as mock_q:
            mock_select = mock.MagicMock()
            mock_select.ask.return_value = "choice_a"
            mock_q.select.return_value = mock_select
            result = p.pick_one("Pick one:", ["choice_a", "choice_b"])
            # pick_one returns the 0-based index of the selected choice
            assert result == 0
            mock_q.select.assert_called_once()

    def test_ask_handles_keyboard_interrupt(self):
        from lib.wizard import prompts as p
        with mock.patch("lib.wizard.prompts.questionary") as mock_q:
            mock_select = mock.MagicMock()
            mock_select.ask.side_effect = KeyboardInterrupt
            mock_q.select.return_value = mock_select
            with pytest.raises((KeyboardInterrupt, SystemExit)):
                p.pick_one("Pick one:", ["a", "b"])

    def test_pick_many_calls_checkbox(self):
        from lib.wizard import prompts as p
        with mock.patch("lib.wizard.prompts.questionary") as mock_q:
            mock_cb = mock.MagicMock()
            mock_cb.ask.return_value = ["a", "c"]
            mock_q.checkbox.return_value = mock_cb
            result = p.pick_many("Choose:", ["a", "b", "c"])
            # pick_many returns 0-based indices
            assert 0 in result  # "a" → index 0
            assert 2 in result  # "c" → index 2
            mock_q.checkbox.assert_called_once()

    def test_confirm_calls_questionary_confirm(self):
        from lib.wizard import prompts as p
        with mock.patch("lib.wizard.prompts.questionary") as mock_q:
            mock_conf = mock.MagicMock()
            mock_conf.ask.return_value = True
            mock_q.confirm.return_value = mock_conf
            result = p.confirm("Are you sure?")
            assert result is True


class TestInteractiveMenu:
    """Test interactive_menu exits cleanly when questionary returns 'exit'."""

    def test_menu_exits_on_quit_selection(self):
        with mock.patch("lib.interactive.questionary") as mock_q, \
             mock.patch("lib.common.process.get_proxy_port", return_value=4000), \
             mock.patch("lib.common.process.find_proxy_pid", return_value=None):
            mock_select = mock.MagicMock()
            mock_select.ask.return_value = "quit"
            mock_q.select.return_value = mock_select

            from lib.interactive import interactive_menu
            try:
                interactive_menu()
            except SystemExit as e:
                assert e.code in (0, None)

    def test_menu_keyboard_interrupt_is_clean(self):
        with mock.patch("lib.interactive.questionary") as mock_q, \
             mock.patch("lib.common.process.get_proxy_port", return_value=4000), \
             mock.patch("lib.common.process.find_proxy_pid", return_value=None):
            mock_select = mock.MagicMock()
            mock_select.ask.side_effect = KeyboardInterrupt
            mock_q.select.return_value = mock_select

            from lib.interactive import interactive_menu
            try:
                interactive_menu()
            except SystemExit as e:
                assert e.code in (0, None)
            except KeyboardInterrupt:
                pass


class TestAuthInteractive:
    """Test auth_interactive with mocked questionary."""

    def test_auth_interactive_dispatches_on_choice(self):
        with mock.patch("lib.interactive.questionary") as mock_q:
            mock_select = mock.MagicMock()
            # Return a chatgpt-like choice string
            mock_select.ask.return_value = "chatgpt      ChatGPT / Codex"
            mock_q.select.return_value = mock_select

            with mock.patch("lib.auth.cli.auth_dispatch") as mock_dispatch:
                mock_dispatch.return_value = None
                from lib.interactive import auth_interactive
                try:
                    auth_interactive()
                except (SystemExit, KeyboardInterrupt):
                    pass
                # dispatch was called with chatgpt
                mock_dispatch.assert_called_once_with(["chatgpt"])
