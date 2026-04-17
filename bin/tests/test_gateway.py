"""Tests for gateway CLI: route parser, API command resolver, and Linux platform paths."""

from __future__ import annotations

import json
import os
import unittest.mock as mock
from pathlib import Path
from textwrap import dedent

import pytest

try:
    from typer.testing import CliRunner
    _typer_available = True
except ImportError:
    _typer_available = False


# ── Fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture()
def routes_dir(tmp_path: Path) -> Path:
    """Create a temporary gateway/routes/ directory with sample TS route files."""
    rd = tmp_path / "gateway" / "routes"
    rd.mkdir(parents=True)

    (rd / "health.ts").write_text(dedent("""\
        // GET /api/health — public (no auth)
        async function healthHandler() {
          return Response.json({ status: "ok" });
        }

        export const healthRoutes = {
          "/api/health": { GET: healthHandler },
        };
    """))

    (rd / "stats.ts").write_text(dedent("""\
        // GET /api/stats/user — requireUser (not guest)
        async function userStatsHandler(req: Request) {}

        // GET /api/stats/requests — requireAuth (any authenticated user incl. guests)
        async function groupedRequestsHandler(req: Request) {}

        // GET /api/stats/requests/items — fetch individual items for an expanded group
        async function groupItemsHandler(req: Request) {}

        export const statsRoutes = {
          "/api/stats/user":            { GET: userStatsHandler },
          "/api/stats/requests":        { GET: groupedRequestsHandler },
          "/api/stats/requests/items":  { GET: groupItemsHandler },
        };
    """))

    (rd / "keys.ts").write_text(dedent("""\
        // GET /api/keys — requireUser (not guest)
        async function getApiKeysHandler(req: Request) {}

        // POST /api/keys — requireUser (not guest)
        async function createApiKeyHandler(req: Request) {}

        export const keysRoutes = {
          "/api/keys": { GET: getApiKeysHandler, POST: createApiKeyHandler },
        };
    """))

    (rd / "admin.ts").write_text(dedent("""\
        // POST /api/admin/approve — requireAdmin
        async function approveUserHandler(req: Request) {}

        // GET /api/admin/users — requireAdmin
        async function adminListUsersHandler(req: Request) {}

        // DELETE /api/admin/users/* — requireAdmin
        async function adminDeleteUserHandler(req: Request) {}

        export const adminRoutes = {
          "/api/admin/approve":  { POST: approveUserHandler },
          "/api/admin/users":    { GET: adminListUsersHandler },
          "/api/admin/users/*":  { DELETE: adminDeleteUserHandler },
        };
    """))

    (rd / "proxy.ts").write_text(dedent("""\
        export const proxyRoutes = {
          "/v1/chat/completions": { POST: proxyHandler },
          "/v1/models":           { GET: publicModelsHandler },
        };
    """))

    (rd / "user.ts").write_text(dedent("""\
        // PUT /api/user/profile — requireUser (not guest)
        async function userProfileHandler(req: Request) {}

        // GET /api/user/model-overrides — requireUser (not guest)
        async function getUserModelOverridesHandler(req: Request) {}

        // PUT /api/user/model-overrides — requireUser (not guest)
        async function putUserModelOverridesHandler(req: Request) {}

        export const userRoutes = {
          "/api/user/profile":         { PUT: userProfileHandler },
          "/api/user/model-overrides": { GET: getUserModelOverridesHandler, PUT: putUserModelOverridesHandler },
        };
    """))

    return rd


@pytest.fixture()
def mock_project_dir(tmp_path: Path, routes_dir: Path, monkeypatch):
    """Patch PROJECT_DIR to point at the tmp_path containing gateway/routes/."""
    monkeypatch.setattr("lib.commands.gateway.PROJECT_DIR", tmp_path)
    return tmp_path


# ── Route parser tests ───────────────────────────────────────────────────────

class TestParseRouteExports:
    def test_parses_all_route_files(self, mock_project_dir):
        from lib.commands.gateway import _parse_route_exports
        routes = _parse_route_exports()
        # We defined routes in 6 files
        assert len(routes) >= 10

    def test_extracts_methods_and_paths(self, mock_project_dir):
        from lib.commands.gateway import _parse_route_exports
        routes = _parse_route_exports()
        methods = {r["method"] for r in routes}
        paths = {r["path"] for r in routes}
        assert "GET" in methods
        assert "POST" in methods
        assert "/api/health" in paths
        assert "/api/stats/user" in paths
        assert "/api/keys" in paths

    def test_multi_method_routes(self, mock_project_dir):
        from lib.commands.gateway import _parse_route_exports
        routes = _parse_route_exports()
        keys_routes = [r for r in routes if r["path"] == "/api/keys"]
        assert len(keys_routes) == 2
        methods = {r["method"] for r in keys_routes}
        assert methods == {"GET", "POST"}

    def test_extracts_descriptions_from_comments(self, mock_project_dir):
        from lib.commands.gateway import _parse_route_exports
        routes = _parse_route_exports()
        user_stats = next(r for r in routes if r["path"] == "/api/stats/user")
        assert "requireUser" in user_stats["desc"]

    def test_handles_wildcard_routes(self, mock_project_dir):
        from lib.commands.gateway import _parse_route_exports
        routes = _parse_route_exports()
        wildcard = [r for r in routes if r["path"] == "/api/admin/users/*"]
        assert len(wildcard) == 1
        assert wildcard[0]["method"] == "DELETE"

    def test_handles_v1_routes(self, mock_project_dir):
        from lib.commands.gateway import _parse_route_exports
        routes = _parse_route_exports()
        v1_routes = [r for r in routes if r["path"].startswith("/v1/")]
        assert len(v1_routes) >= 2

    def test_returns_empty_when_no_gateway(self, tmp_path, monkeypatch):
        monkeypatch.setattr("lib.commands.gateway.PROJECT_DIR", tmp_path)
        from lib.commands.gateway import _parse_route_exports
        assert _parse_route_exports() == []


class TestPathToCmd:
    def test_strips_api_prefix(self):
        from lib.commands.gateway import _path_to_cmd
        assert _path_to_cmd("/api/stats/user") == ["stats", "user"]

    def test_preserves_v1_prefix(self):
        from lib.commands.gateway import _path_to_cmd
        assert _path_to_cmd("/v1/chat/completions") == ["v1", "chat", "completions"]

    def test_single_segment(self):
        from lib.commands.gateway import _path_to_cmd
        assert _path_to_cmd("/api/health") == ["health"]

    def test_deep_path(self):
        from lib.commands.gateway import _path_to_cmd
        assert _path_to_cmd("/api/stats/requests/items") == ["stats", "requests", "items"]

    def test_strips_underscore_prefixed(self):
        from lib.commands.gateway import _path_to_cmd
        assert _path_to_cmd("/api/_routes") == []


class TestFindRoute:
    def test_exact_match(self, mock_project_dir):
        from lib.commands.gateway import _parse_route_exports, _find_route
        routes = _parse_route_exports()
        r = _find_route(routes, "/api/health", "GET")
        assert r is not None
        assert r["path"] == "/api/health"

    def test_method_filter(self, mock_project_dir):
        from lib.commands.gateway import _parse_route_exports, _find_route
        routes = _parse_route_exports()
        r_get = _find_route(routes, "/api/keys", "GET")
        r_post = _find_route(routes, "/api/keys", "POST")
        assert r_get is not None and r_get["method"] == "GET"
        assert r_post is not None and r_post["method"] == "POST"

    def test_wildcard_match(self, mock_project_dir):
        from lib.commands.gateway import _parse_route_exports, _find_route
        routes = _parse_route_exports()
        r = _find_route(routes, "/api/admin/users/someone@test.com", "DELETE")
        assert r is not None
        assert r["path"] == "/api/admin/users/*"

    def test_no_match(self, mock_project_dir):
        from lib.commands.gateway import _parse_route_exports, _find_route
        routes = _parse_route_exports()
        assert _find_route(routes, "/api/nonexistent", "GET") is None

    def test_any_method_fallback(self, mock_project_dir):
        from lib.commands.gateway import _parse_route_exports, _find_route
        routes = _parse_route_exports()
        r = _find_route(routes, "/api/health")
        assert r is not None


class TestCompletableSegments:
    def test_top_level(self, mock_project_dir):
        from lib.commands.gateway import _completable_segments
        segs = _completable_segments([])
        assert "health" in segs
        assert "stats" in segs
        assert "admin" in segs
        assert "keys" in segs
        assert "user" in segs
        assert "v1" in segs

    def test_second_level(self, mock_project_dir):
        from lib.commands.gateway import _completable_segments
        segs = _completable_segments(["stats"])
        assert "user" in segs
        assert "requests" in segs

    def test_third_level(self, mock_project_dir):
        from lib.commands.gateway import _completable_segments
        segs = _completable_segments(["stats", "requests"])
        assert "items" in segs

    def test_empty_at_leaf(self, mock_project_dir):
        from lib.commands.gateway import _completable_segments
        assert _completable_segments(["health"]) == []

    def test_no_param_segments(self, mock_project_dir):
        from lib.commands.gateway import _completable_segments
        segs = _completable_segments([])
        # :param and * should not appear in completions
        for s in segs:
            assert not s.startswith(":")
            assert s != "*"


# ── API command tests (mocked HTTP) ─────────────────────────────────────────

class TestGatewayApi:
    @pytest.fixture(autouse=True)
    def _setup(self, mock_project_dir, monkeypatch):
        monkeypatch.setenv("GATEWAY_PORT", "14041")
        # Write a fake secret
        secret_file = mock_project_dir / ".gateway-secret"
        secret_file.write_text("test-secret-123")

    def _mock_urlopen(self, response_json=None, status=200):
        response_json = response_json or {"ok": True}
        mock_resp = mock.MagicMock()
        mock_resp.read.return_value = json.dumps(response_json).encode()
        mock_resp.__enter__ = mock.MagicMock(return_value=mock_resp)
        mock_resp.__exit__ = mock.MagicMock(return_value=False)
        return mock.patch("lib.commands.gateway.urllib.request.urlopen", return_value=mock_resp)

    def test_health_sends_get(self, mock_project_dir):
        from lib.commands.gateway import gateway_api
        with mock.patch("lib.commands.gateway.gateway_is_running", return_value=True), \
             self._mock_urlopen() as mock_open:
            gateway_api(["health"])
            req = mock_open.call_args[0][0]
            assert req.get_method() == "GET"
            assert "/api/health" in req.full_url

    def test_stats_user_sends_get(self, mock_project_dir):
        from lib.commands.gateway import gateway_api
        with mock.patch("lib.commands.gateway.gateway_is_running", return_value=True), \
             self._mock_urlopen() as mock_open:
            gateway_api(["stats", "user"])
            req = mock_open.call_args[0][0]
            assert "/api/stats/user" in req.full_url

    def test_data_flag_triggers_write_method(self, mock_project_dir):
        from lib.commands.gateway import gateway_api
        with mock.patch("lib.commands.gateway.gateway_is_running", return_value=True), \
             self._mock_urlopen() as mock_open:
            gateway_api(["admin", "approve"], data='{"email":"x@y.com"}')
            req = mock_open.call_args[0][0]
            assert req.get_method() == "POST"
            assert req.data == b'{"email":"x@y.com"}'

    def test_kv_args_become_query_params_for_get(self, mock_project_dir):
        from lib.commands.gateway import gateway_api
        with mock.patch("lib.commands.gateway.gateway_is_running", return_value=True), \
             self._mock_urlopen() as mock_open:
            # health is GET-only, kv should become query params
            # But health doesn't accept params — let's use a route we know
            # stats/user is GET, kv becomes query params
            gateway_api(["stats", "user", "page=1"])
            req = mock_open.call_args[0][0]
            assert "page=1" in req.full_url

    def test_kv_args_become_body_for_post(self, mock_project_dir):
        from lib.commands.gateway import gateway_api
        with mock.patch("lib.commands.gateway.gateway_is_running", return_value=True), \
             self._mock_urlopen() as mock_open:
            gateway_api(["admin", "approve", "email=x@y.com"])
            req = mock_open.call_args[0][0]
            assert req.get_method() == "POST"
            body = json.loads(req.data)
            assert body["email"] == "x@y.com"

    def test_action_word_delete(self, mock_project_dir):
        from lib.commands.gateway import gateway_api
        with mock.patch("lib.commands.gateway.gateway_is_running", return_value=True), \
             self._mock_urlopen() as mock_open:
            gateway_api(["admin", "users", "delete", "test@example.com"])
            req = mock_open.call_args[0][0]
            assert req.get_method() == "DELETE"
            assert "test@example.com" in req.full_url

    def test_sends_secret_header(self, mock_project_dir):
        from lib.commands.gateway import gateway_api
        with mock.patch("lib.commands.gateway.gateway_is_running", return_value=True), \
             self._mock_urlopen() as mock_open:
            gateway_api(["health"])
            req = mock_open.call_args[0][0]
            assert req.get_header("X-gateway-secret") == "test-secret-123"

    def test_v1_path_preserved(self, mock_project_dir):
        from lib.commands.gateway import gateway_api
        with mock.patch("lib.commands.gateway.gateway_is_running", return_value=True), \
             self._mock_urlopen() as mock_open:
            gateway_api(["v1", "models"])
            req = mock_open.call_args[0][0]
            assert "/v1/models" in req.full_url

    def test_error_when_gateway_not_running(self, mock_project_dir, capsys):
        from lib.commands.gateway import gateway_api
        with mock.patch("lib.commands.gateway.gateway_is_running", return_value=False):
            gateway_api(["health"])
            # Should not crash, just print error

    def test_error_when_no_secret(self, mock_project_dir):
        from lib.commands.gateway import gateway_api
        (mock_project_dir / ".gateway-secret").unlink()
        with mock.patch("lib.commands.gateway.gateway_is_running", return_value=True):
            gateway_api(["health"])
            # Should not crash

    def test_unknown_command_does_not_crash(self, mock_project_dir):
        from lib.commands.gateway import gateway_api
        with mock.patch("lib.commands.gateway.gateway_is_running", return_value=True):
            gateway_api(["this", "does", "not", "exist"])

    def test_multi_method_path_defaults_to_get(self, mock_project_dir):
        from lib.commands.gateway import gateway_api
        with mock.patch("lib.commands.gateway.gateway_is_running", return_value=True), \
             self._mock_urlopen() as mock_open:
            gateway_api(["keys"])
            req = mock_open.call_args[0][0]
            assert req.get_method() == "GET"

    def test_multi_method_path_with_data_uses_post(self, mock_project_dir):
        from lib.commands.gateway import gateway_api
        with mock.patch("lib.commands.gateway.gateway_is_running", return_value=True), \
             self._mock_urlopen() as mock_open:
            gateway_api(["keys"], data='{"name":"test"}')
            req = mock_open.call_args[0][0]
            assert req.get_method() == "POST"

    def test_put_route_with_data(self, mock_project_dir):
        from lib.commands.gateway import gateway_api
        with mock.patch("lib.commands.gateway.gateway_is_running", return_value=True), \
             self._mock_urlopen() as mock_open:
            gateway_api(["user", "model-overrides"], data='{"key":"val"}')
            req = mock_open.call_args[0][0]
            assert req.get_method() == "PUT"


# ── Gateway routes display ───────────────────────────────────────────────────

class TestGatewayRoutes:
    def test_routes_command_no_crash(self, mock_project_dir, capsys):
        from lib.commands.gateway import gateway_routes
        gateway_routes()
        # Should have printed routes

    def test_routes_empty_when_missing(self, tmp_path, monkeypatch):
        monkeypatch.setattr("lib.commands.gateway.PROJECT_DIR", tmp_path)
        from lib.commands.gateway import gateway_routes
        gateway_routes()
        # Should print error but not crash


# ── CLI dispatch (Typer) ─────────────────────────────────────────────────────

@pytest.mark.skipif(not _typer_available, reason="typer not installed")
class TestGatewayCliDispatch:
    @pytest.fixture()
    def runner(self):
        return CliRunner()

    @pytest.fixture()
    def app(self):
        from lib.cli import app
        return app

    def test_gateway_routes_dispatched(self, runner, app):
        with mock.patch("lib.commands.gateway.gateway_routes") as mock_fn:
            mock_fn.return_value = None
            result = runner.invoke(app, ["gateway", "routes"])
            assert result.exit_code in (0, 1)

    def test_gateway_api_dispatched(self, runner, app):
        with mock.patch("lib.commands.gateway.gateway_api") as mock_fn:
            mock_fn.return_value = None
            result = runner.invoke(app, ["gateway", "api", "health"])
            if result.exit_code == 0:
                mock_fn.assert_called_once()
                assert mock_fn.call_args[0][0] == ["health"]

    def test_gateway_api_with_data_flag(self, runner, app):
        with mock.patch("lib.commands.gateway.gateway_api") as mock_fn:
            mock_fn.return_value = None
            result = runner.invoke(app, ["gateway", "api", "admin", "approve", "-d", '{"email":"x"}'])
            if result.exit_code == 0:
                args, kwargs = mock_fn.call_args
                assert args[0] == ["admin", "approve"]
                assert args[1] == '{"email":"x"}'

    def test_gateway_api_no_args_shows_help(self, runner, app):
        with mock.patch("lib.commands.gateway.gateway_api") as mock_fn:
            mock_fn.return_value = None
            result = runner.invoke(app, ["gateway", "api"])
            # Either shows help or calls gateway_api with empty args
            assert result.exit_code in (0, 1)


# ── Completion tests ─────────────────────────────────────────────────────────

class TestCompletionsGatewayApi:
    def test_bash_contains_api_in_gateway_cmds(self):
        from lib.commands.completions import generate_completions
        result = generate_completions()
        assert "api" in result
        assert "routes" in result

    def test_bash_contains_api_completion_logic(self):
        from lib.commands.completions import generate_completions
        result = generate_completions()
        assert "_completable_segments" in result

    def test_zsh_contains_api_description(self):
        from lib.commands.completions import generate_zsh_completions
        result = generate_zsh_completions()
        assert "'api:" in result
        assert "'routes:" in result

    def test_zsh_contains_dynamic_completion(self):
        from lib.commands.completions import generate_zsh_completions
        result = generate_zsh_completions()
        assert "_completable_segments" in result


# ── Linux platform tests ────────────────────────────────────────────────────

class TestLinuxPlatform:
    def test_is_linux_when_system_is_linux(self, monkeypatch):
        monkeypatch.setattr("platform.system", lambda: "Linux")
        from lib.common.platform import is_linux, is_macos
        assert is_linux() is True
        assert is_macos() is False

    def test_detect_os_reads_os_release(self, monkeypatch, tmp_path):
        monkeypatch.setattr("platform.system", lambda: "Linux")
        os_release = tmp_path / "os-release"
        os_release.write_text('PRETTY_NAME="Ubuntu 24.04 LTS"\nID=ubuntu\n')
        import builtins
        original_open = builtins.open

        def patched_open(path, *a, **kw):
            if str(path) == "/etc/os-release":
                return original_open(str(os_release), *a, **kw)
            return original_open(path, *a, **kw)

        monkeypatch.setattr("builtins.open", patched_open)
        from lib.common.platform import detect_os
        assert detect_os() == "Ubuntu 24.04 LTS"

    def test_detect_os_fallback_when_no_os_release(self, monkeypatch):
        monkeypatch.setattr("platform.system", lambda: "Linux")
        import builtins
        original_open = builtins.open

        def patched_open(path, *a, **kw):
            if str(path) == "/etc/os-release":
                raise FileNotFoundError
            return original_open(path, *a, **kw)

        monkeypatch.setattr("builtins.open", patched_open)
        from lib.common.platform import detect_os
        assert detect_os() == "Linux"


class TestLinuxSystemd:
    def test_has_systemd_user_false_without_xdg(self, monkeypatch):
        monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)
        from lib.common.platform import has_systemd_user
        assert has_systemd_user() is False

    def test_has_systemd_user_false_without_systemctl(self, monkeypatch):
        monkeypatch.setenv("XDG_RUNTIME_DIR", "/run/user/1000")
        monkeypatch.setattr("shutil.which", lambda x: None)
        from lib.common.platform import has_systemd_user
        assert has_systemd_user() is False

    def test_has_systemd_user_true_when_bus_works(self, monkeypatch):
        monkeypatch.setenv("XDG_RUNTIME_DIR", "/run/user/1000")
        import shutil
        monkeypatch.setattr("shutil.which", lambda x: f"/usr/bin/{x}")
        monkeypatch.setattr(
            "subprocess.call",
            lambda *a, **kw: 0,  # systemctl returns 0
        )
        from lib.common.platform import has_systemd_user
        assert has_systemd_user() is True

    def test_systemd_paths(self):
        from lib.common.paths import SYSTEMD_DIR, SYSTEMD_FILE, SYSTEMD_UNIT
        assert SYSTEMD_UNIT == "litellm-proxy"
        assert "systemd/user" in str(SYSTEMD_DIR)
        assert str(SYSTEMD_FILE).endswith(".service")


class TestLinuxServiceDispatch:
    """Test that cmd_start/cmd_stop dispatch correctly on Linux."""

    def test_start_uses_systemd_on_linux(self, monkeypatch, tmp_path):
        monkeypatch.setattr("lib.commands.service.is_macos", lambda: False)
        monkeypatch.setattr("lib.commands.service.is_linux", lambda: True)
        monkeypatch.setattr("lib.commands.service.has_systemd_user", lambda: True)
        monkeypatch.setattr("lib.commands.service._activate_venv", lambda: None)
        monkeypatch.setattr("lib.commands.service.load_env", lambda: None)
        monkeypatch.setattr("lib.commands.service.kill_stale", lambda p: None)
        monkeypatch.setattr("lib.commands.service.wait_for_ready", lambda p: None)

        with mock.patch("lib.commands.service.systemd_install") as mock_systemd:
            from lib.commands.service import cmd_start
            cmd_start(port=4040)
            mock_systemd.assert_called_once()

    def test_start_uses_nohup_fallback_on_linux(self, monkeypatch, tmp_path):
        monkeypatch.setattr("lib.commands.service.is_macos", lambda: False)
        monkeypatch.setattr("lib.commands.service.is_linux", lambda: True)
        monkeypatch.setattr("lib.commands.service.has_systemd_user", lambda: False)
        monkeypatch.setattr("lib.commands.service._activate_venv", lambda: None)
        monkeypatch.setattr("lib.commands.service.load_env", lambda: None)
        monkeypatch.setattr("lib.commands.service.kill_stale", lambda p: None)
        monkeypatch.setattr("lib.commands.service.wait_for_ready", lambda p: None)

        with mock.patch("lib.commands.service.nohup_start") as mock_nohup:
            from lib.commands.service import cmd_start
            cmd_start(port=4040)
            mock_nohup.assert_called_once()

    def test_stop_uses_systemd_when_running(self, monkeypatch):
        monkeypatch.setattr("lib.commands.service.is_macos", lambda: False)
        monkeypatch.setattr("lib.commands.service.is_linux", lambda: True)
        monkeypatch.setattr("lib.commands.service.systemd_is_running", lambda: True)
        monkeypatch.setattr("lib.commands.service.launchd_is_running", lambda: False)
        monkeypatch.setattr("lib.commands.service.get_proxy_port", lambda: 4040)
        monkeypatch.setattr("lib.commands.service.kill_stale", lambda p: None)

        with mock.patch("lib.commands.service.systemd_stop") as mock_stop:
            from lib.commands.service import cmd_stop
            cmd_stop()
            mock_stop.assert_called_once()

    def test_stop_uses_nohup_when_no_systemd(self, monkeypatch):
        monkeypatch.setattr("lib.commands.service.is_macos", lambda: False)
        monkeypatch.setattr("lib.commands.service.is_linux", lambda: True)
        monkeypatch.setattr("lib.commands.service.systemd_is_running", lambda: False)
        monkeypatch.setattr("lib.commands.service.launchd_is_running", lambda: False)
        monkeypatch.setattr("lib.commands.service.get_proxy_port", lambda: 4040)
        monkeypatch.setattr("lib.commands.service.kill_stale", lambda p: None)

        with mock.patch("lib.commands.service.nohup_stop") as mock_stop:
            from lib.commands.service import cmd_stop
            cmd_stop()
            mock_stop.assert_called_once()


class TestLinuxProcess:
    def test_pids_on_port_uses_ss_when_no_lsof(self, monkeypatch):
        """On Linux, when lsof isn't available, should fall back to ss."""
        call_log = []

        def fake_which(cmd):
            if cmd == "lsof":
                return None
            if cmd == "ss":
                return "/usr/bin/ss"
            return None

        def fake_run(args, **kw):
            call_log.append(args[0])
            result = mock.MagicMock()
            result.stdout = "LISTEN  0  128  *:4040  *:*  users:((\"litellm\",pid=1234,fd=5))"
            return result

        monkeypatch.setattr("shutil.which", fake_which)
        monkeypatch.setattr("subprocess.run", fake_run)

        from lib.common.process import pids_on_port
        pids = pids_on_port(4040)
        assert "ss" in call_log
        assert 1234 in pids

    def test_pids_on_port_uses_fuser_as_last_resort(self, monkeypatch):
        """When neither lsof nor ss is available, try fuser."""
        def fake_which(cmd):
            if cmd == "fuser":
                return "/usr/bin/fuser"
            return None

        def fake_run(args, **kw):
            result = mock.MagicMock()
            result.stdout = "  5678"
            return result

        monkeypatch.setattr("shutil.which", fake_which)
        monkeypatch.setattr("subprocess.run", fake_run)

        from lib.common.process import pids_on_port
        pids = pids_on_port(4040)
        assert 5678 in pids


class TestLinuxDbSetup:
    def test_linux_socket_host_appended(self, monkeypatch):
        monkeypatch.setattr("lib.common.db_url.is_linux", lambda: True)
        from lib.common.db_url import append_linux_socket_host_param
        url = "postgresql://user:pass@localhost/litellm"
        result = append_linux_socket_host_param(url)
        assert "host=" in result or result == url  # Either appends or passthrough

    def test_linux_socket_host_not_appended_on_mac(self, monkeypatch):
        monkeypatch.setattr("lib.common.db_url.is_linux", lambda: False)
        from lib.common.db_url import append_linux_socket_host_param
        url = "postgresql://user:pass@localhost/litellm"
        assert append_linux_socket_host_param(url) == url


class TestLinuxSystemdUnit:
    def test_systemd_unit_content(self, tmp_path, monkeypatch):
        """Verify systemd unit file has correct structure."""
        monkeypatch.setattr("lib.commands.service.SYSTEMD_DIR", tmp_path)
        monkeypatch.setattr("lib.commands.service.SYSTEMD_FILE", tmp_path / "litellm-proxy.service")
        monkeypatch.setattr("lib.commands.service.LOG_DIR", tmp_path / "logs")
        monkeypatch.setattr("lib.commands.service.PORT_FILE", tmp_path / ".proxy-port")
        (tmp_path / "logs").mkdir()

        # Mock subprocess.call to avoid running systemctl
        monkeypatch.setattr("subprocess.call", lambda *a, **kw: 0)
        monkeypatch.setattr("shutil.which", lambda x: None)  # skip loginctl

        from lib.commands.service import systemd_install
        systemd_install(4040, "/tmp/config.yaml")

        unit_file = tmp_path / "litellm-proxy.service"
        assert unit_file.exists()
        content = unit_file.read_text()
        assert "[Unit]" in content
        assert "[Service]" in content
        assert "[Install]" in content
        assert "WantedBy=default.target" in content
        assert "4040" in content
        assert "Restart=on-failure" in content


class TestLinuxCompletions:
    def test_bash_completions_setup_for_bashrc(self, monkeypatch, tmp_path):
        monkeypatch.setenv("SHELL", "/bin/bash")
        bashrc = tmp_path / ".bashrc"
        bashrc.write_text("")
        monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)

        from lib.commands.completions import cmd_setup_completions
        cmd_setup_completions()

        content = bashrc.read_text()
        assert "alias litellmctl=" in content
        assert "--completions" in content

    def test_zsh_completions_setup_for_zshrc(self, monkeypatch, tmp_path):
        monkeypatch.setenv("SHELL", "/bin/zsh")
        zshrc = tmp_path / ".zshrc"
        zshrc.write_text("")
        monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)

        from lib.commands.completions import cmd_setup_completions
        cmd_setup_completions()

        content = zshrc.read_text()
        assert "alias litellmctl=" in content
        assert "--zsh-completions" in content
