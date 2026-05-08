#!/usr/bin/env bash
# UserPromptSubmit hook — extract durable memories from the user's prompt and
# save them to the gateway's supermemory store. Runs the LLM extraction in a
# detached background process so the user's prompt is never blocked.
#
# This is the "deterministic save" counterpart to recall-on-prompt.sh: the
# agent is *supposed* to call mcp__supermemory__memory(action="save") on its
# own when the user reveals a preference / fact / feedback, but in practice
# that often gets missed. This hook closes the gap by running an extractor
# LLM over every prompt and persisting whatever qualifies.
#
# Wire: hooks.UserPromptSubmit, identified by path substring
#   `supermemory/hooks/extract-on-prompt.sh`
# for clean uninstall via uninstall.sh.
#
# Env (set via per-hook env prefix in settings.json):
#   LLM_GATEWAY_URL              required — gateway origin
#   LLM_GATEWAY_API_KEY          required — caller's API key
#   SUPERMEMORY_AUTO_SAVE        "1" enables (default), "0" disables
#   SUPERMEMORY_AUTO_MODEL       extractor model alias, default "lite"
#   SUPERMEMORY_AUTO_PROJECT     bucket to save into, default "default"
#   SUPERMEMORY_AUTO_DEDUPE_SIM  similarity threshold above which a candidate
#                                 is treated as already-saved (0.0-1.0),
#                                 default 0.85
#   SUPERMEMORY_AUTO_LOG_DIR     where to log save activity,
#                                 default $HOME/.claude/plugin-state/supermemory
set -u

[ "${SUPERMEMORY_AUTO_SAVE:-1}" = "1" ] || exit 0
if [ -z "${LLM_GATEWAY_URL:-}" ] || [ -z "${LLM_GATEWAY_API_KEY:-}" ]; then
    exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
    exit 0
fi

INPUT="$(cat)"
[ -n "$INPUT" ] || exit 0

LOG_DIR="${SUPERMEMORY_AUTO_LOG_DIR:-$HOME/.claude/plugin-state/supermemory}"
mkdir -p "$LOG_DIR" 2>/dev/null || true

# Detach the extractor so the prompt is never blocked. All errors are silent —
# this hook fires on every prompt, so a slow/down gateway must never surface as
# an error to the user.
(
SUPERMEMORY_INPUT="$INPUT" python3 - \
    "$LLM_GATEWAY_URL" \
    "$LLM_GATEWAY_API_KEY" \
    "${SUPERMEMORY_AUTO_MODEL:-lite}" \
    "${SUPERMEMORY_AUTO_PROJECT:-default}" \
    "${SUPERMEMORY_AUTO_DEDUPE_SIM:-0.85}" \
    "$LOG_DIR" \
    <<'PYEOF' >/dev/null 2>&1
import json, os, sys, urllib.request, urllib.error, re, time

gateway, api_key, model, project, dedupe_sim_s, log_dir = sys.argv[1:7]
log_file = os.path.join(log_dir, "auto-save.log")

try:
    dedupe_sim = float(dedupe_sim_s)
except ValueError:
    dedupe_sim = 0.85

raw = os.environ.get("SUPERMEMORY_INPUT") or ""
try:
    event = json.loads(raw)
except Exception:
    sys.exit(0)

prompt = (event.get("prompt") or "").strip()
# Trivial prompts ("ok", "thanks") are noise to a semantic extractor.
if len(prompt) < 20:
    sys.exit(0)
# Claude Code shell-escape — not a real query.
if prompt.startswith("!"):
    sys.exit(0)
# Slash command invocation — tool call, not a statement.
if prompt.startswith("/") and not prompt.startswith("//"):
    sys.exit(0)

# Trim before sending to the extractor LLM.
if len(prompt) > 8000:
    prompt = prompt[:8000]

# Mirrors the trigger taxonomy in session-start.sh so what gets auto-saved is
# the same set the agent would have saved had it called the MCP tool itself.
SYSTEM = (
    "You extract long-term memories from a single user message in a Claude "
    "Code conversation. Save ONLY items that will be useful in FUTURE "
    "conversations — not the current task itself.\n"
    "\n"
    "Save when the user reveals:\n"
    "- A preference, working-style rule, or constraint (\"I prefer X\", "
    "\"always Y\", \"never Z\", \"stop doing W\").\n"
    "- A fact about themselves, their role, team, stack, or product.\n"
    "- Feedback that should shape future behavior — corrections AND "
    "confirmations of a non-obvious choice.\n"
    "- An external resource (Linear project, Slack channel, dashboard, "
    "runbook, repo URL) future sessions would need to find again.\n"
    "- A project goal, deadline, constraint, or stakeholder context not "
    "derivable from the code.\n"
    "\n"
    "Do NOT save:\n"
    "- Code patterns, architecture, file paths, conventions (derivable from "
    "the repo).\n"
    "- Ephemeral task state (\"I'm working on X right now\", \"can you fix "
    "this bug\").\n"
    "- Questions, greetings, thanks, meta-questions about the assistant or "
    "its plugins.\n"
    "- Anything obvious from a `git log` or already-documented in CLAUDE.md.\n"
    "\n"
    "Each item must be a single self-contained sentence or two phrased in "
    "the third person about the user (\"User prefers …\", \"User's team "
    "uses …\"), so it makes sense in isolation in a future session. "
    "Include the *why* if the user gave one.\n"
    "\n"
    "Return STRICT JSON: {\"memories\":[{\"content\":\"…\"}, …]}. "
    "Empty array if nothing qualifies. No prose, no markdown fences."
)

body = {
    "model": model,
    "messages": [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": prompt},
    ],
    "max_tokens": 500,
    "temperature": 0.0,
}

req = urllib.request.Request(
    gateway.rstrip("/") + "/v1/chat/completions",
    data=json.dumps(body).encode(),
    headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=15.0) as resp:
        data = json.loads(resp.read())
except Exception:
    sys.exit(0)

try:
    text = data["choices"][0]["message"]["content"] or ""
except Exception:
    sys.exit(0)

# Tolerate models that wrap JSON in markdown fences or surrounding prose.
m = re.search(r"\{[\s\S]*\}", text)
if not m:
    sys.exit(0)
try:
    parsed = json.loads(m.group(0))
except Exception:
    sys.exit(0)

memories = parsed.get("memories")
if not isinstance(memories, list) or not memories:
    sys.exit(0)


def post(path, payload, timeout):
    r = urllib.request.Request(
        gateway.rstrip("/") + path,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read())


saved = []
skipped_dup = 0
errors = 0

for mem in memories:
    if not isinstance(mem, dict):
        continue
    content = (mem.get("content") or "").strip()
    if not content or len(content) < 12 or len(content) > 4000:
        continue

    # Server hashes (project, content) for exact-match dedupe; semantic search
    # catches paraphrase-level duplicates that hash-dedupe would miss.
    try:
        sdata = post(
            "/api/plugins/supermemory/search",
            {"query": content, "limit": 3, "project": project},
            timeout=3.0,
        )
        existing = sdata.get("results") or []
        if any(
            isinstance(r.get("similarity"), (int, float))
            and r["similarity"] >= dedupe_sim
            for r in existing
        ):
            skipped_dup += 1
            continue
    except Exception:
        pass  # If dedupe lookup fails, fall through and let the server hash dedupe.

    try:
        post(
            "/api/plugins/supermemory/save",
            {"content": content, "project": project},
            timeout=5.0,
        )
        saved.append(content)
    except Exception:
        errors += 1

if saved or skipped_dup or errors:
    try:
        with open(log_file, "a") as f:
            ts = time.strftime("%Y-%m-%dT%H:%M:%S")
            for c in saved:
                f.write(f"{ts} SAVED  {c}\n")
            if skipped_dup:
                f.write(f"{ts} DEDUP  skipped {skipped_dup} duplicate(s)\n")
            if errors:
                f.write(f"{ts} ERROR  {errors} save call(s) failed\n")
    except Exception:
        pass
PYEOF
) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true

exit 0
