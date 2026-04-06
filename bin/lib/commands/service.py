"""Service management — start/stop/restart/logs/proxy."""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

from ..common.paths import (
    PROJECT_DIR, VENV_DIR, PORT_FILE, LOG_DIR, CONFIG_FILE, PIDFILE,
    LAUNCHD_LABEL, LAUNCHD_PLIST, SYSTEMD_UNIT, SYSTEMD_DIR, SYSTEMD_FILE,
)
from ..common.env import load_env, patch_perf_defaults
from ..common.formatting import info, warn, error
from ..common.platform import is_macos, is_linux, has_systemd_user
from ..common.process import get_proxy_port, find_proxy_pid, kill_stale, kill_other_instances, find_all_litellm_pids
from ..common.network import wait_for_ready


def _activate_venv() -> None:
    """Add venv to PATH and set VIRTUAL_ENV."""
    if not VENV_DIR.exists():
        error("No virtualenv found. Run 'litellmctl install' first.")
        sys.exit(1)
    venv_bin = str(VENV_DIR / "bin")
    os.environ["VIRTUAL_ENV"] = str(VENV_DIR)
    os.environ["PATH"] = f"{venv_bin}:{os.environ.get('PATH', '')}"


def _perf_flags() -> list[str]:
    flags = []
    workers = os.environ.get("NUM_WORKERS", "4")
    try:
        if int(workers) > 1:
            flags.extend(["--num_workers", workers])
    except ValueError:
        pass
    keepalive = os.environ.get("KEEPALIVE_TIMEOUT", "")
    if keepalive:
        flags.extend(["--keepalive_timeout", keepalive])
    return flags


def _ensure_log_dir() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)


def _parse_env_for_plist() -> str:
    """Generate plist XML env block from .env."""
    env_file = PROJECT_DIR / ".env"
    if not env_file.exists():
        return ""
    block = ""
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if key:
            block += f"    <key>{key}</key>\n    <string>{value}</string>\n"
    return block


def _plist_perf_args() -> str:
    """Generate plist XML perf args."""
    args = ""
    workers = os.environ.get("NUM_WORKERS", "4")
    try:
        if int(workers) > 1:
            args += f"    <string>--num_workers</string>\n    <string>{workers}</string>\n"
    except ValueError:
        pass
    keepalive = os.environ.get("KEEPALIVE_TIMEOUT", "")
    if keepalive:
        args += f"    <string>--keepalive_timeout</string>\n    <string>{keepalive}</string>\n"
    return args


def launchd_install(port: int, config: str) -> None:
    _ensure_log_dir()
    LAUNCHD_PLIST.parent.mkdir(parents=True, exist_ok=True)

    env_block = _parse_env_for_plist()
    perf_args = _plist_perf_args()

    plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{VENV_DIR}/bin/litellm</string>
    <string>--config</string>
    <string>{config}</string>
    <string>--port</string>
    <string>{port}</string>
{perf_args}  </array>
  <key>WorkingDirectory</key>
  <string>{PROJECT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>{VENV_DIR}/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>VIRTUAL_ENV</key>
    <string>{VENV_DIR}</string>
{env_block}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{LOG_DIR}/proxy.log</string>
  <key>StandardErrorPath</key>
  <string>{LOG_DIR}/proxy-error.log</string>
</dict>
</plist>"""

    LAUNCHD_PLIST.write_text(plist)
    PORT_FILE.write_text(str(port))

    uid = os.getuid()
    subprocess.call(["launchctl", "bootout", f"gui/{uid}/{LAUNCHD_LABEL}"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ret = subprocess.call(["launchctl", "bootstrap", f"gui/{uid}", str(LAUNCHD_PLIST)])
    if ret != 0:
        warn("launchd bootstrap failed, retrying once ...")
        subprocess.call(["launchctl", "bootout", f"gui/{uid}/{LAUNCHD_LABEL}"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
        subprocess.check_call(["launchctl", "bootstrap", f"gui/{uid}", str(LAUNCHD_PLIST)])

    info(f"Installed launchd service ({LAUNCHD_LABEL})")
    info(f"Proxy starting on port {port} (auto-starts on login)")
    info(f"Logs: {LOG_DIR}/proxy.log")


def launchd_stop() -> None:
    uid = os.getuid()
    ret = subprocess.call(["launchctl", "bootout", f"gui/{uid}/{LAUNCHD_LABEL}"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if ret == 0:
        info("Service stopped.")
    else:
        warn("Service not running.")


def launchd_is_running() -> bool:
    uid = os.getuid()
    return subprocess.call(
        ["launchctl", "print", f"gui/{uid}/{LAUNCHD_LABEL}"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ) == 0


def launchd_uninstall() -> None:
    uid = os.getuid()
    subprocess.call(["launchctl", "bootout", f"gui/{uid}/{LAUNCHD_LABEL}"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    LAUNCHD_PLIST.unlink(missing_ok=True)
    info("Removed launchd service.")


def _parse_env_for_systemd() -> str:
    env_file = PROJECT_DIR / ".env"
    if not env_file.exists():
        return ""
    lines = ""
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        lines += f"Environment={line}\n"
    return lines


def systemd_install(port: int, config: str) -> None:
    _ensure_log_dir()
    SYSTEMD_DIR.mkdir(parents=True, exist_ok=True)

    env_lines = _parse_env_for_systemd()
    perf = " ".join(_perf_flags())

    unit = f"""[Unit]
Description=LiteLLM Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory={PROJECT_DIR}
ExecStart={VENV_DIR}/bin/litellm --config {config} --port {port} {perf}
Restart=on-failure
RestartSec=5

Environment=PATH={VENV_DIR}/bin:/usr/local/bin:/usr/bin:/bin
Environment=VIRTUAL_ENV={VENV_DIR}
{env_lines}
StandardOutput=append:{LOG_DIR}/proxy.log
StandardError=append:{LOG_DIR}/proxy-error.log

[Install]
WantedBy=default.target"""

    SYSTEMD_FILE.write_text(unit)
    PORT_FILE.write_text(str(port))

    subprocess.call(["systemctl", "--user", "daemon-reload"])
    subprocess.call(["systemctl", "--user", "enable", SYSTEMD_UNIT])
    subprocess.call(["systemctl", "--user", "start", SYSTEMD_UNIT])

    info(f"Installed systemd user service ({SYSTEMD_UNIT})")
    info(f"Proxy starting on port {port} (auto-starts on login)")
    info(f"Logs: {LOG_DIR}/proxy.log")

    import shutil
    if shutil.which("loginctl"):
        result = subprocess.run(
            ["loginctl", "show-user", os.environ.get("USER", ""), "--property=Linger"],
            capture_output=True, text=True,
        )
        if "yes" not in result.stdout:
            warn(f"Enabling loginctl linger for {os.environ.get('USER', '')} (keeps service running after logout)")
            subprocess.call(["loginctl", "enable-linger", os.environ.get("USER", "")],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def systemd_stop() -> None:
    ret = subprocess.call(["systemctl", "--user", "stop", SYSTEMD_UNIT],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if ret == 0:
        info("Service stopped.")
    else:
        warn("Service not running.")


def systemd_is_running() -> bool:
    return subprocess.call(
        ["systemctl", "--user", "is-active", SYSTEMD_UNIT],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ) == 0


def systemd_uninstall() -> None:
    subprocess.call(["systemctl", "--user", "stop", SYSTEMD_UNIT],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.call(["systemctl", "--user", "disable", SYSTEMD_UNIT],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    SYSTEMD_FILE.unlink(missing_ok=True)
    subprocess.call(["systemctl", "--user", "daemon-reload"])
    info("Removed systemd service.")


def nohup_start(port: int, config: str) -> None:
    _ensure_log_dir()
    _activate_venv()
    load_env()
    PORT_FILE.write_text(str(port))

    cmd = [
        str(VENV_DIR / "bin" / "litellm"),
        "--config", config,
        "--port", str(port),
        *_perf_flags(),
    ]
    log_out = open(LOG_DIR / "proxy.log", "a")
    log_err = open(LOG_DIR / "proxy-error.log", "a")
    proc = subprocess.Popen(cmd, stdout=log_out, stderr=log_err,
                            start_new_session=True)
    PIDFILE.write_text(str(proc.pid))
    info(f"Proxy started in background (PID {proc.pid}, port {port})")
    info(f"Logs: {LOG_DIR}/proxy.log")
    info("Note: add 'litellmctl start' to cron @reboot for auto-start")


def nohup_stop() -> None:
    pid = None
    if PIDFILE.exists():
        try:
            pid = int(PIDFILE.read_text().strip())
        except ValueError:
            pass
    if pid is None:
        pid = find_proxy_pid()
    if pid is not None:
        try:
            os.kill(pid, 0)  # check alive
            os.kill(pid, 15)  # SIGTERM
            PIDFILE.unlink(missing_ok=True)
            info(f"Stopped (PID {pid}).")
            return
        except ProcessLookupError:
            pass
    PIDFILE.unlink(missing_ok=True)
    warn("No proxy found.")


def nohup_is_running() -> bool:
    if PIDFILE.exists():
        try:
            pid = int(PIDFILE.read_text().strip())
            os.kill(pid, 0)
            return True
        except (ValueError, ProcessLookupError):
            pass
    return find_proxy_pid() is not None


def cmd_start(port: int = 4040, config: str | None = None) -> None:
    load_env()
    patch_perf_defaults()
    load_env()  # reload so new defaults take effect
    cfg = config or str(CONFIG_FILE)

    # Check if config file exists, prompt for wizard if missing
    cfg_path = Path(cfg) if cfg.startswith("/") else PROJECT_DIR / cfg
    if not cfg_path.exists():

        from ..common.platform import is_interactive
        from ..common.prompts import confirm
        warn(f"Config file not found: {cfg_path}")
        if is_interactive():
            if confirm("Run the wizard to create config.yaml now?"):
                from ..wizard.core import run_wizard
                success = run_wizard()
                # Re-check config file exists after wizard completes
                if not success or not cfg_path.exists():
                    error("Config file still not found. Wizard may have been cancelled.")
                    error("Run 'litellmctl wizard' to create one.")
                    sys.exit(1)
            else:
                error("Cannot start proxy without config.yaml. Run 'litellmctl wizard' to create one.")
                sys.exit(1)
        else:
            error("Cannot start proxy without config.yaml. Run 'litellmctl wizard' to create one.")
            sys.exit(1)

    _activate_venv()
    load_env()
    kill_stale(port)
    kill_other_instances(port)

    if is_macos():
        launchd_install(port, cfg)
    elif is_linux() and has_systemd_user():
        systemd_install(port, cfg)
    else:
        nohup_start(port, cfg)
    wait_for_ready(port)


def cmd_stop() -> None:
    port = get_proxy_port()
    if is_macos() and launchd_is_running():
        launchd_stop()
    elif is_linux() and systemd_is_running():
        systemd_stop()
    else:
        nohup_stop()
    kill_stale(port)
    kill_other_instances(port)


def cmd_restart() -> None:
    load_env()
    patch_perf_defaults()
    load_env()  # reload so new defaults take effect
    port = get_proxy_port()
    config = str(CONFIG_FILE)

    # Check if config file exists
    if not CONFIG_FILE.exists():

        from ..common.platform import is_interactive
        from ..common.prompts import confirm
        warn(f"Config file not found: {CONFIG_FILE}")
        if is_interactive():
            if confirm("Run the wizard to create config.yaml now?"):
                from ..wizard.core import run_wizard
                success = run_wizard()
                # Re-check config file exists after wizard completes
                if not success or not CONFIG_FILE.exists():
                    error("Config file still not found. Wizard may have been cancelled.")
                    error("Run 'litellmctl wizard' to create one.")
                    sys.exit(1)
            else:
                error("Cannot restart proxy without config.yaml. Run 'litellmctl wizard' to create one.")
                sys.exit(1)
        else:
            error("Cannot restart proxy without config.yaml. Run 'litellmctl wizard' to create one.")
            sys.exit(1)

    info("Restarting proxy ...")

    # Stop all litellm instances — service-managed and orphans alike
    if is_macos() and launchd_is_running():
        launchd_stop()
    elif is_linux() and systemd_is_running():
        subprocess.call(["systemctl", "--user", "stop", SYSTEMD_UNIT],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        nohup_stop()

    time.sleep(1)
    kill_stale(port)

    # Kill any litellm processes on other ports (e.g. old systemd service on 4000)
    remaining = find_all_litellm_pids()
    if remaining:
        warn(f"Killing {len(remaining)} remaining litellm process(es): {' '.join(map(str, remaining))}")
        for pid in remaining:
            try:
                os.kill(pid, 15)
            except (ProcessLookupError, PermissionError):
                pass
        time.sleep(2)
        for pid in remaining:
            try:
                os.kill(pid, 0)
                os.kill(pid, 9)
            except (ProcessLookupError, PermissionError):
                pass

    _activate_venv()
    load_env()

    if is_macos():
        launchd_install(port, config)
    elif is_linux() and has_systemd_user():
        subprocess.call(["systemctl", "--user", "daemon-reload"])
        subprocess.call(["systemctl", "--user", "start", SYSTEMD_UNIT])
        info("Restarted.")
    else:
        nohup_start(port, config)
    wait_for_ready(port)


def cmd_logs() -> None:
    _ensure_log_dir()
    logfile = LOG_DIR / "proxy.log"
    errfile = LOG_DIR / "proxy-error.log"

    if not logfile.exists() and not errfile.exists():
        warn("No log files found yet. Start the proxy first with 'litellmctl start'.")
        return

    info(f"Tailing {LOG_DIR}  (Ctrl+C to stop)")
    files = [str(f) for f in [logfile, errfile] if f.exists()]
    try:
        subprocess.call(["tail", "-f", *files])
    except KeyboardInterrupt:
        pass


def cmd_proxy(port: int = 4040, config: str | None = None, extra_args: list[str] | None = None) -> None:
    _activate_venv()
    load_env()
    # Unset DEBUG for foreground
    os.environ.pop("DEBUG", None)

    cfg = config or str(CONFIG_FILE)
    kill_stale(port)
    PORT_FILE.write_text(str(port))

    info(f"Starting LiteLLM proxy on port {port} (foreground) ...")
    cmd = [
        str(VENV_DIR / "bin" / "litellm"),
        "--config", cfg,
        "--port", str(port),
        *_perf_flags(),
        *(extra_args or []),
    ]
    os.execvp(cmd[0], cmd)
