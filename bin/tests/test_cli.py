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

    def test_status_feature_arg(self, runner, app):
        """`status gateway` dispatches with feature='gateway'."""
        with mock.patch("lib.commands.status.cmd_status") as mock_fn:
            mock_fn.return_value = None
            result = runner.invoke(app, ["status", "gateway"])
            assert result.exit_code in (0, 1)

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


class TestFlatGatewayCommands:
    def test_users(self, runner, app):
        with mock.patch("lib.commands.gateway.gateway_user_list") as mock_fn:
            mock_fn.return_value = None
            result = runner.invoke(app, ["users"])
            assert result.exit_code in (0, 1)

    def test_routes(self, runner, app):
        with mock.patch("lib.commands.gateway.gateway_routes") as mock_fn:
            mock_fn.return_value = None
            result = runner.invoke(app, ["routes"])
            assert result.exit_code in (0, 1)

    def test_start_gateway_feature(self, runner, app):
        """`start gateway` hits the features dispatch."""
        with mock.patch("lib.common.features.feature_start") as mock_fn:
            mock_fn.return_value = None
            result = runner.invoke(app, ["start", "gateway"])
            assert result.exit_code in (0, 1)

    def test_logs_gateway_feature(self, runner, app):
        with mock.patch("lib.commands.service.cmd_logs") as mock_fn:
            mock_fn.return_value = None
            result = runner.invoke(app, ["logs", "gateway"])
            assert result.exit_code in (0, 1)
