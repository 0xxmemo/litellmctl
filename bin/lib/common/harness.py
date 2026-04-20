"""Runtime harness detection.

The CLI supports two runtime harnesses:

- ``host`` (default) — services are registered with launchd (macOS) or
  systemd (Linux). This is the VPC install path driven by ``install.sh``.

- ``docker`` — services are started foreground via ``os.execvp`` so s6-overlay
  can supervise them. No launchd/systemd/nohup registration.

Switch by setting ``LITELLM_HARNESS=docker`` in the container environment.
"""

from __future__ import annotations

import os


def harness() -> str:
    return os.environ.get("LITELLM_HARNESS", "host").strip().lower() or "host"


def is_docker() -> bool:
    return harness() == "docker"
