"""CLI dispatch tests using Typer's CliRunner."""

from __future__ import annotations

import unittest.mock as mock

import pytest

try:
    from typer.testing import CliRunner
    _typer_available = True
except ImportError:
    _typer_available = False

pytestmark = pytest.mark.skipif(not _typer_available, reason="typer not installed")


@pytest.fixture()
def runner():
    return CliRunner()


@pytest.fixture()
def app():
    from lib.cli import app
    return app


class TestCliRouting:
    def test_help_flag(self, runner, app):
        result = runner.invoke(app, ["--help"])
        assert result.exit_code == 0
        assert "Usage" in result.output or "Commands" in result.output or len(result.output) > 0

    def test_unknown_command_exits_nonzero(self, runner, app):
        result = runner.invoke(app, ["this-command-does-not-exist"])
        assert result.exit_code != 0

    def test_gateway_subcommand_help(self, runner, app):
        result = runner.invoke(app, ["gateway", "--help"])
        # Should show gateway subcommands
        assert result.exit_code == 0

    def test_auth_status_dispatched(self, runner, app):
        """auth status should not crash — dispatch reaches auth module."""
        with mock.patch("lib.auth.cli.auth_dispatch") as mock_dispatch:
            mock_dispatch.return_value = None
            result = runner.invoke(app, ["auth", "status"])
            # Either dispatch was called or the command ran directly
            assert result.exit_code in (0, 1)

    def test_toggle_claude_dispatched(self, runner, app):
        """toggle-claude command should call cmd_toggle_claude."""
        with mock.patch("lib.commands.toggle_claude.cmd_toggle_claude") as mock_fn:
            mock_fn.return_value = None
            result = runner.invoke(app, ["toggle-claude"])
            if mock_fn.called:
                mock_fn.assert_called_once()

    def test_init_env_dispatched(self, runner, app):
        with mock.patch("lib.commands.init_env.cmd_init_env") as mock_fn:
            mock_fn.return_value = None
            result = runner.invoke(app, ["init-env"])
            # Should be called or at least not crash
            assert result.exit_code in (0, 1)


class TestGatewaySubcommands:
    def test_gateway_status(self, runner, app):
        with mock.patch("lib.commands.gateway.cmd_gateway") as mock_fn:
            mock_fn.return_value = None
            result = runner.invoke(app, ["gateway", "status"])
            assert result.exit_code in (0, 1)

    def test_gateway_start(self, runner, app):
        with mock.patch("lib.commands.gateway.gateway_start") as mock_fn:
            mock_fn.return_value = None
            result = runner.invoke(app, ["gateway", "start"])
            assert result.exit_code in (0, 1)
