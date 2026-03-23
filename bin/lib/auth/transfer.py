"""Credential export/import for transferring auth between machines."""

from __future__ import annotations

import base64
import json
import os
import re
import select
import sys
import time

from ..common.formatting import console
from ..common.paths import PROJECT_DIR, BIN_DIR
from .core import _copy_to_clipboard, _expiry_label

from .chatgpt import _chatgpt_auth_file
from .gemini import _gemini_auth_file
from .qwen import _qwen_auth_file
from .kimi import _kimi_auth_file

AUTH_PROVIDERS = [
    ("chatgpt", "ChatGPT / Codex", _chatgpt_auth_file),
    ("gemini",  "Gemini CLI",      _gemini_auth_file),
    ("qwen",    "Qwen Portal",     _qwen_auth_file),
    ("kimi",    "Kimi Code",       _kimi_auth_file),
]


def export_creds(selected: list[str] | None = None):
    available = []
    for key, label, getter in AUTH_PROVIDERS:
        f = getter()
        if f.exists():
            try:
                data = json.loads(f.read_text())
                available.append((key, label, f, data))
            except Exception:
                pass

    if not available:
        console.print("[red]No auth files found. Run 'litellmctl auth <provider>' first.[/]")
        sys.exit(1)

    if selected:
        chosen = []
        for key, label, f, data in available:
            if key in selected:
                chosen.append((key, label, f, data))
        missing = set(selected) - {k for k, *_ in chosen}
        if missing:
            console.print(f"[yellow]Not found: {', '.join(missing)}[/]")
        if not chosen:
            console.print("[red]No matching auth files.[/]"); sys.exit(1)
    else:
        console.print()
        console.print("[bold]Available credentials:[/]")
        for i, (key, label, f, data) in enumerate(available, 1):
            exp = _expiry_label(data)
            color = "green" if "left" in exp else "red"
            console.print(f"  [{i}] {key:<12} {label:<20} ([{color}]{exp}[/])")

        console.print()
        ans = input("Select (comma-separated numbers, or 'all') [all]: ").strip()
        if not ans or ans.lower() == "all":
            chosen = available
        else:
            indices = []
            for part in ans.split(","):
                part = part.strip()
                if part.isdigit() and 1 <= int(part) <= len(available):
                    indices.append(int(part) - 1)
            if not indices:
                console.print("[red]No valid selection.[/]"); sys.exit(1)
            chosen = [available[i] for i in indices]

    # Build a single self-contained bash script with one base64 blob
    # All credentials are bundled into one JSON object, base64-encoded once
    bundle = {}
    for key, label, f, data in chosen:
        bundle[f.name] = data

    # Single base64-encoded blob containing all credentials
    bundle_json = json.dumps(bundle, indent=2)
    bundle_b64 = base64.b64encode(bundle_json.encode()).decode()

    lines = [
        "#!/usr/bin/env bash",
        "# litellmctl credential transfer",
        f"# Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"# Credentials: {', '.join(k for k, *_ in chosen)}",
        "#",
        "# Paste this entire block into a terminal on the target machine.",
        "set -euo pipefail",
        'D="${LITELLM_DIR:-$HOME/.litellm}"',
        'mkdir -p "$D"',
        "",
        "# Decode and install all credentials",
        'read -r -d "" BUNDLE << \'BUNDLE_EOF\' || true',
        bundle_b64,
        "BUNDLE_EOF",
        "",
        'echo "$BUNDLE" | base64 -d | python3 -c "',
        "import sys, json, os",
        "D = os.environ.get('LITELLM_DIR', os.path.expanduser('~/.litellm'))",
        "for fname, data in json.load(sys.stdin).items():",
        "    p = os.path.join(D, fname)",
        "    with open(p, 'w') as f: json.dump(data, f, indent=2)",
        "    os.chmod(p, 0o600)",
        "    print(f'  ✓ {fname}')",
        '"',
        'echo ""',
        'echo "Done! Imported to $D"',
        '[ -x "$D/bin/litellmctl" ] && "$D/bin/litellmctl" init-env 2>/dev/null && echo "  ✓ .env paths synced" || echo "  Run: litellmctl init-env"',
    ]

    script = "\n".join(lines) + "\n"

    if _copy_to_clipboard(script):
        console.print()
        console.print(f"[green]✓ Copied transfer script to clipboard ({len(chosen)} credential(s))[/]")
        console.print("[dim]  Paste it into a terminal on the target machine.[/]")
    else:
        console.print()
        console.print("[yellow]Could not copy to clipboard. Printing script:\n[/]")
        console.print("[dim]" + "─" * 60 + "[/]")
        print(script)
        console.print("[dim]" + "─" * 60 + "[/]")

    console.print()


def _import_write(fname: str, b64data: str) -> bool:
    """Decode base64, validate JSON, write to PROJECT_DIR. Returns True on success."""
    try:
        decoded = base64.b64decode(b64data)
        json.loads(decoded)
    except Exception:
        console.print(f"[red]  Invalid base64/JSON for {fname}[/]")
        return False
    target = PROJECT_DIR / fname
    target.write_bytes(decoded)
    os.chmod(target, 0o600)
    console.print(f"[green]  ✓ {fname}[/]")
    return True


# Regex for new single-blob format: captures the base64 between BUNDLE_EOF markers
_BUNDLE_RE = re.compile(r"read -r -d \"\" BUNDLE << 'BUNDLE_EOF'.*?\n([A-Za-z0-9+/=]+)\nBUNDLE_EOF", re.DOTALL)


def _read_paste() -> list[str]:
    """Read pasted content from stdin, auto-detecting end of paste."""
    if not sys.stdin.isatty():
        return [l.strip() for l in sys.stdin.readlines()]

    # Interactive: pasted text arrives in rapid bursts.
    # Wait for a short idle gap after content to detect end of paste.
    fd = sys.stdin.fileno()
    buf = ""
    got_content = False
    while True:
        timeout = 0.5 if got_content else 60.0
        ready, _, _ = select.select([sys.stdin], [], [], timeout)
        if not ready:
            if got_content:
                break  # paste finished — no more data after idle gap
            continue   # still waiting for first input
        chunk = os.read(fd, 65536).decode(errors="replace")
        if not chunk:
            break  # EOF
        buf += chunk
        got_content = True

    return [l.strip() for l in buf.splitlines()]


def import_creds():
    console.print()
    console.print("[bold]Import credentials[/]")
    console.print("[dim]" + "─" * 40 + "[/]")
    console.print("Paste the export script below:")
    console.print()

    raw_lines = _read_paste()

    if not raw_lines:
        console.print("[yellow]No input received.[/]")
        console.print()
        return

    raw = "\n".join(raw_lines)
    imported = 0

    # Try new single-blob format first
    m = _BUNDLE_RE.search(raw)
    if m:
        bundle_b64 = m.group(1)
        try:
            bundle = json.loads(base64.b64decode(bundle_b64))
            for fname, data in bundle.items():
                if _import_write(fname, base64.b64encode(json.dumps(data).encode()).decode()):
                    imported += 1
        except Exception as e:
            console.print(f"[red]Invalid bundle format: {e}[/]")

    if imported == 0:
        # Fallback: try legacy line-by-line parsing
        console.print("[dim]Note: Legacy format detected, use new export for cleaner transfers[/]\n")
        for line in raw_lines:
            if not line or line.startswith("#"):
                continue
            parts = line.split(None, 1)
            if len(parts) != 2:
                continue
            fname, b64data = parts
            if not fname.startswith("auth.") or not fname.endswith(".json"):
                continue
            if _import_write(fname, b64data):
                imported += 1

    if imported:
        console.print(f"\n[green]✓ Imported {imported} credential(s)[/]")
        # Auto-run init-env if possible
        try:
            import subprocess
            subprocess.run(
                [str(BIN_DIR / "litellmctl"), "init-env"],
                capture_output=True, timeout=5,
            )
            console.print("[green]  ✓ .env paths synced[/]")
        except Exception:
            console.print("[dim]  Run: litellmctl init-env[/]")
    else:
        console.print("[yellow]\nNo credentials imported.[/]")

    console.print()
