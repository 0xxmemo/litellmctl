#!/usr/bin/env bash
# Stop hook — extract durable memories from the most recent exchange and
# persist them. Replaces the old UserPromptSubmit-time extractor, which
# saved off a single user message before the assistant ever responded —
# which meant speculation and rejected proposals could land in memory as
# if they were the user's conclusion.
#
# Why Stop instead of UserPromptSubmit
# ────────────────────────────────────
# By the time Stop fires, the latest exchange is *finished*: we can see the
# user's statement, the assistant's response, AND any follow-up the user
# made (corrections, "yes do that", "no stop"). That's the signal needed to
# distinguish "the user actually concluded X" from "the user floated X and
# the conversation moved on."
#
# What this hook does
# ───────────────────
# 1. Reads the Stop event JSON: transcript_path, session_id, cwd.
# 2. Derives the project slug from cwd (git-root basename, slugified;
#    falls back to cwd basename). No more global "default" bucket.
# 3. Throttles: skips if the transcript byte size hasn't grown since the
#    last extraction for this session. Stop fires often; we don't.
# 4. Pulls the last N messages from the transcript JSONL and the top
#    existing memories for this project.
# 5. Asks the extractor LLM to emit BOTH save and forget candidates:
#       - save: items the user has clearly concluded / declared, with the
#               dialogue providing confirmation (their own statement, or
#               assent to the assistant's proposal). Speculation, rejected
#               ideas, and pure task descriptions are excluded.
#       - forget: existing memories the latest exchange contradicts or
#                 supersedes. Lets memory evolve as the user's stance does.
# 6. Applies save+forget against the gateway, scoped to the derived project.
#
# Wire: hooks.Stop, identified by path substring
#   `supermemory/hooks/extract-on-stop.sh`
# for clean uninstall.
#
# Env (set via per-hook env prefix in settings.json):
#   LLM_GATEWAY_URL              required
#   LLM_GATEWAY_API_KEY          required
#   SUPERMEMORY_AUTO_SAVE        "1" enables (default), "0" disables
#   SUPERMEMORY_AUTO_MODEL       extractor model alias, default "lite"
#   SUPERMEMORY_AUTO_PROJECT     hard override for project slug; if unset,
#                                derived from cwd
#   SUPERMEMORY_AUTO_DEDUPE_SIM  similarity above which a save candidate
#                                is treated as already-saved (0.0-1.0),
#                                default 0.85
#   SUPERMEMORY_AUTO_MAX_TURNS   max recent transcript turns to send to
#                                the extractor, default 12
#   SUPERMEMORY_AUTO_MIN_INTERVAL  minimum seconds between extractions for
#                                the same session, default 30
#   SUPERMEMORY_AUTO_LOG_DIR     where to log activity,
#                                default $HOME/.claude/plugin-state/supermemory
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
mkdir -p "$LOG_DIR/sessions" 2>/dev/null || true

# Detach so Stop returns immediately. Stop hooks can keep the agent paused
# until they exit, and we never want a slow gateway to stall the user.
(
SUPERMEMORY_INPUT="$INPUT" python3 - \
    "$LLM_GATEWAY_URL" \
    "$LLM_GATEWAY_API_KEY" \
    "${SUPERMEMORY_AUTO_MODEL:-lite}" \
    "${SUPERMEMORY_AUTO_PROJECT:-}" \
    "${SUPERMEMORY_AUTO_DEDUPE_SIM:-0.85}" \
    "${SUPERMEMORY_AUTO_MAX_TURNS:-12}" \
    "${SUPERMEMORY_AUTO_MIN_INTERVAL:-30}" \
    "$LOG_DIR" \
    <<'PYEOF' >/dev/null 2>&1
import json, os, sys, urllib.request, re, time, subprocess, hashlib

(gateway, api_key, model, project_override, dedupe_sim_s,
 max_turns_s, min_interval_s, log_dir) = sys.argv[1:9]
log_file = os.path.join(log_dir, "auto-save.log")
sessions_dir = os.path.join(log_dir, "sessions")

try:
    dedupe_sim = float(dedupe_sim_s)
except ValueError:
    dedupe_sim = 0.85
try:
    max_turns = max(2, min(40, int(max_turns_s)))
except ValueError:
    max_turns = 12
try:
    min_interval = max(0, int(min_interval_s))
except ValueError:
    min_interval = 30

raw = os.environ.get("SUPERMEMORY_INPUT") or ""
try:
    event = json.loads(raw)
except Exception:
    sys.exit(0)

# Ignore re-entrant Stop firings — the hook itself doesn't continue, but
# defensively: if stop_hook_active is true Claude Code is already mid-loop.
if event.get("stop_hook_active") is True:
    sys.exit(0)

session_id = event.get("session_id") or ""
transcript_path = event.get("transcript_path") or ""
cwd = event.get("cwd") or os.getcwd()

if not transcript_path or not os.path.isfile(transcript_path):
    sys.exit(0)


def slugify(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9._-]+", "-", s)
    s = re.sub(r"-+", "-", s)
    s = s.strip("-._")
    s = s[:64]
    return s if (s and re.match(r"^[a-z0-9]", s)) else ""


def derive_project(cwd: str) -> str:
    if project_override:
        slug = slugify(project_override)
        if slug:
            return slug
    if cwd:
        try:
            out = subprocess.run(
                ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                capture_output=True, text=True, timeout=2.0,
            )
            if out.returncode == 0:
                root = out.stdout.strip()
                if root:
                    slug = slugify(os.path.basename(root))
                    if slug:
                        return slug
        except Exception:
            pass
        slug = slugify(os.path.basename(cwd.rstrip("/")))
        if slug:
            return slug
    return "default"


project = derive_project(cwd)

# ── Throttle: skip if transcript hasn't changed since last run ────────────
state_key = hashlib.sha1(
    (session_id + "|" + transcript_path).encode()
).hexdigest()[:16]
state_file = os.path.join(sessions_dir, state_key + ".json")
prev_state = {}
try:
    with open(state_file) as f:
        prev_state = json.load(f)
except Exception:
    prev_state = {}

try:
    cur_size = os.path.getsize(transcript_path)
except OSError:
    sys.exit(0)
now = int(time.time())

if (
    prev_state.get("size") == cur_size
    or (now - int(prev_state.get("ts", 0))) < min_interval
):
    sys.exit(0)

# ── Load last N user/assistant text turns from the transcript JSONL ───────
def load_recent_turns(path: str, limit: int):
    lines = []
    try:
        with open(path, "r", errors="replace") as f:
            for line in f:
                line = line.strip()
                if line:
                    lines.append(line)
    except Exception:
        return []
    turns = []
    for raw_line in reversed(lines):
        if len(turns) >= limit:
            break
        try:
            obj = json.loads(raw_line)
        except Exception:
            continue
        # Claude Code transcript entries: {type: "user"|"assistant", message: {role, content}}
        ttype = obj.get("type")
        if ttype not in ("user", "assistant"):
            continue
        message = obj.get("message") or {}
        role = message.get("role") or ttype
        content = message.get("content")
        text = ""
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            chunks = []
            for c in content:
                if not isinstance(c, dict):
                    continue
                if c.get("type") == "text" and isinstance(c.get("text"), str):
                    chunks.append(c["text"])
                elif c.get("type") == "tool_use":
                    name = c.get("name") or "tool"
                    chunks.append(f"[tool_use:{name}]")
                elif c.get("type") == "tool_result":
                    chunks.append("[tool_result]")
            text = "\n".join(chunks)
        text = (text or "").strip()
        if not text:
            continue
        # Skip injected system-reminder / hook-context blocks — they are
        # noise for the extractor and can drown the real user signal.
        if text.startswith("<system-reminder>") or text.startswith("[supermemory]"):
            continue
        # Trim per-turn so we don't blow the LLM's context budget.
        if len(text) > 2000:
            text = text[:2000] + "…"
        turns.append({"role": role, "text": text})
    turns.reverse()
    return turns


turns = load_recent_turns(transcript_path, max_turns)
if len(turns) < 2:
    # Need at least one user + one assistant turn to read intent + confirmation.
    try:
        with open(state_file, "w") as f:
            json.dump({"size": cur_size, "ts": now}, f)
    except Exception:
        pass
    sys.exit(0)


def post(path: str, payload, timeout: float):
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


# ── Pull existing memories for this project so the LLM can detect ─────────
# contradictions (forget candidates) and skip duplicates more accurately. ─
existing = []
try:
    last_user = next(
        (t["text"] for t in reversed(turns) if t["role"] == "user"),
        "",
    )
    seed_query = (last_user or " ".join(t["text"] for t in turns[-3:]))[:800]
    sdata = post(
        "/api/plugins/supermemory/search",
        {"query": seed_query, "limit": 20, "project": project},
        timeout=3.0,
    )
    for r in sdata.get("results") or []:
        c = (r.get("content") or "").strip()
        if c:
            existing.append({"id": r.get("id"), "content": c})
except Exception:
    pass

existing_block = (
    "\n".join(f"- {e['content']}" for e in existing[:20])
    if existing else "(none)"
)

transcript_block = "\n\n".join(
    f"[{t['role']}]\n{t['text']}" for t in turns
)

SYSTEM = (
    "You curate a long-term memory store for a single user across Claude Code "
    "sessions. You receive (a) the most recent turns of one conversation and "
    "(b) the existing memories already saved for the user's CURRENT project. "
    "Your job is to decide what to SAVE and what to FORGET so the store stays "
    "accurate and current.\n"
    "\n"
    "Only emit a SAVE when the dialogue itself confirms the user has CONCLUDED "
    "the item — not merely brainstormed it. A safe save looks like:\n"
    "  • The user states a preference, rule, fact, or constraint in their own "
    "    words (\"I prefer X\", \"my team uses Y\", \"never Z\").\n"
    "  • The user explicitly accepts an assistant proposal (\"yes do that\", "
    "    \"perfect, keep doing that\", \"that bundled PR was the right call\").\n"
    "  • The user gives concrete corrective feedback that should change future "
    "    behavior (\"stop doing X\", \"don't use Y\", \"always do Z instead\").\n"
    "Do NOT save:\n"
    "  • Speculation or proposals from EITHER party that the user has not "
    "    confirmed.\n"
    "  • Ideas the user rejected or walked back later in the same exchange.\n"
    "  • Ephemeral task state (\"I'm working on X right now\").\n"
    "  • Code patterns, architecture, file paths — derivable from the repo.\n"
    "  • Greetings, thanks, meta-questions about the assistant.\n"
    "\n"
    "Emit a FORGET for any existing memory the latest exchange CONTRADICTS, "
    "SUPERSEDES, or invalidates (e.g. user changed stack, switched tooling, "
    "reversed a preference, ended a project). Use the existing memory's exact "
    "content string. If the user is just refining (\"actually it's X not Y\"), "
    "emit forget(old) AND save(new). Do NOT forget memories that are merely "
    "off-topic for the current turn.\n"
    "\n"
    "Phrase saves in third person about the user (\"User prefers …\", \"User's "
    "team uses …\") so they read sensibly in isolation in a future session. "
    "Include the *why* if the dialogue gave one.\n"
    "\n"
    "Return STRICT JSON: "
    "{\"save\":[{\"content\":\"…\"}, …], \"forget\":[{\"content\":\"…\"}, …]}. "
    "Either array may be empty. No prose, no markdown fences."
)

USER_BLOCK = (
    f"PROJECT: {project}\n"
    f"\n"
    f"EXISTING MEMORIES FOR THIS PROJECT:\n{existing_block}\n"
    f"\n"
    f"RECENT CONVERSATION TURNS (oldest → newest):\n{transcript_block}"
)

body = {
    "model": model,
    "messages": [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": USER_BLOCK},
    ],
    "max_tokens": 700,
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
    with urllib.request.urlopen(req, timeout=20.0) as resp:
        data = json.loads(resp.read())
except Exception:
    # Stamp the run anyway so we don't hammer the gateway on the same
    # transcript size if it's down.
    try:
        with open(state_file, "w") as f:
            json.dump({"size": cur_size, "ts": now}, f)
    except Exception:
        pass
    sys.exit(0)

try:
    text = data["choices"][0]["message"]["content"] or ""
except Exception:
    sys.exit(0)

# Tolerate models that wrap JSON in fences or surrounding prose.
m = re.search(r"\{[\s\S]*\}", text)
if not m:
    try:
        with open(state_file, "w") as f:
            json.dump({"size": cur_size, "ts": now}, f)
    except Exception:
        pass
    sys.exit(0)
try:
    parsed = json.loads(m.group(0))
except Exception:
    sys.exit(0)

save_items = parsed.get("save") if isinstance(parsed, dict) else None
forget_items = parsed.get("forget") if isinstance(parsed, dict) else None
if not isinstance(save_items, list):
    save_items = []
if not isinstance(forget_items, list):
    forget_items = []

saved, forgot, skipped_dup, errors = [], [], 0, 0

# ── Apply forgets first (so a paired update lands cleanly) ────────────────
for fm in forget_items:
    if not isinstance(fm, dict):
        continue
    content = (fm.get("content") or "").strip()
    if not content or len(content) < 6 or len(content) > 4000:
        continue
    try:
        post(
            "/api/plugins/supermemory/forget",
            {"content": content, "project": project},
            timeout=5.0,
        )
        forgot.append(content)
    except Exception:
        # Fall back to id-based forget if the LLM gave us one.
        fid = fm.get("id")
        if isinstance(fid, str) and fid:
            try:
                post(
                    "/api/plugins/supermemory/forget",
                    {"id": fid},
                    timeout=5.0,
                )
                forgot.append(content)
                continue
            except Exception:
                pass
        errors += 1

# ── Then apply saves with semantic dedupe ─────────────────────────────────
for mem in save_items:
    if not isinstance(mem, dict):
        continue
    content = (mem.get("content") or "").strip()
    if not content or len(content) < 12 or len(content) > 4000:
        continue
    try:
        sdata = post(
            "/api/plugins/supermemory/search",
            {"query": content, "limit": 3, "project": project},
            timeout=3.0,
        )
        if any(
            isinstance(r.get("similarity"), (int, float))
            and r["similarity"] >= dedupe_sim
            for r in (sdata.get("results") or [])
        ):
            skipped_dup += 1
            continue
    except Exception:
        pass

    try:
        post(
            "/api/plugins/supermemory/save",
            {"content": content, "project": project},
            timeout=5.0,
        )
        saved.append(content)
    except Exception:
        errors += 1

try:
    with open(state_file, "w") as f:
        json.dump({"size": cur_size, "ts": now}, f)
except Exception:
    pass

if saved or forgot or skipped_dup or errors:
    try:
        with open(log_file, "a") as f:
            ts = time.strftime("%Y-%m-%dT%H:%M:%S")
            for c in saved:
                f.write(f"{ts} SAVE   [{project}] {c}\n")
            for c in forgot:
                f.write(f"{ts} FORGET [{project}] {c}\n")
            if skipped_dup:
                f.write(f"{ts} DEDUP  [{project}] skipped {skipped_dup} duplicate(s)\n")
            if errors:
                f.write(f"{ts} ERROR  [{project}] {errors} call(s) failed\n")
    except Exception:
        pass
PYEOF
) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true

exit 0
