#!/usr/bin/env bash
# Runs inside the Ubuntu container. Exercises every install/uninstall path
# exactly as a real consumer would: copy command → paste into their shell → enter.
#
# For each asset it does TWO passes:
#   pass 1 — unquoted URL (what the Copy button currently produces)
#   pass 2 — quoted URL   (what the fix should produce)
#
# It captures stdout/stderr + final settings state so we can compare.
set -u

ORIGIN="${HARNESS_ORIGIN:-http://host.docker.internal:18041}"
API_KEY="${API_KEY:-test-api-key-12345}"
RESULTS="/tmp/harness-results"
rm -rf "$RESULTS" && mkdir -p "$RESULTS"

pass() { echo -e "\e[32m  PASS\e[0m $*"; }
fail() { echo -e "\e[31m  FAIL\e[0m $*"; FAILURES=$((FAILURES+1)); }
xpass() { echo -e "\e[33m  XPASS\e[0m $*  (negative control unexpectedly succeeded — regression in the reproducer?)"; FAILURES=$((FAILURES+1)); }
xfail() { echo -e "\e[33m  XFAIL\e[0m $*  (negative control failed as expected)"; }
FAILURES=0

reset_home() {
  rm -rf "$HOME/.claude"
  mkdir -p "$HOME/.claude"
}

run_case() {
  # $1 label  $2 shell  $3 cmd  $4 expected_artefact (relative to $HOME that
  # only exists if the install actually ran)  $5 positive|negative
  local label="$1" shell="$2" cmd="$3" artefact="$4" expectation="${5:-positive}"
  local log="$RESULTS/${label}.log"
  echo "── $label ──"
  echo "# shell: $shell"                            >  "$log"
  echo "# cmd:   $cmd"                              >> "$log"
  reset_home
  "$shell" -c "$cmd" >>"$log" 2>&1
  local rc=$?
  echo "# rc:    $rc"                               >> "$log"

  # Side-effect check: the install only leaves $artefact behind if the
  # embedded install.sh actually executed. This avoids false positives from
  # matching echo-strings that appear inside the printed script body when
  # curl is accidentally backgrounded.
  local ok=0
  [ -e "$HOME/$artefact" ] && ok=1

  if [ "$expectation" = "negative" ]; then
    if [ "$ok" -eq 1 ]; then
      xpass "$label (rc=$rc, $artefact present — reproducer no longer triggers bug)"
    else
      xfail "$label (rc=$rc, $artefact absent — bug reproduced)"
    fi
  else
    if [ "$ok" -eq 1 ]; then
      pass "$label (rc=$rc, $artefact present)"
    else
      fail "$label (rc=$rc, $artefact absent)"
      echo "    ── last 20 lines of $log ──"
      tail -20 "$log" | sed 's/^/    /'
    fi
  fi
}

# Artefacts left behind by a real install run. If these do NOT exist, the
# install did not execute (regardless of what text appeared on stdout).
PLUGIN_ARTEFACT=".claude/plugins/supermemory/PLUGIN.md"
CLAUDE_CTX_ARTEFACT=".claude/plugins/claude-context/PLUGIN.md"
SKILL_IMG_ARTEFACT=".claude/skills/image-generation/SKILL.md"
SKILL_PM_ARTEFACT=".claude/skills/pick-model/SKILL.md"

echo "═══ plugin: supermemory (bash, unquoted — reproduce bug) ═══"
run_case "plugin-supermemory-bash-unquoted" \
  bash \
  "curl -fsSL ${ORIGIN}/api/plugins/install.sh?slug=supermemory&target=claude-code | LLM_GATEWAY_API_KEY=\"$API_KEY\" bash" \
  "$PLUGIN_ARTEFACT" negative

echo "═══ plugin: supermemory (bash, quoted — expected fix) ═══"
run_case "plugin-supermemory-bash-quoted" \
  bash \
  "curl -fsSL \"${ORIGIN}/api/plugins/install.sh?slug=supermemory&target=claude-code\" | LLM_GATEWAY_API_KEY=\"$API_KEY\" bash" \
  "$PLUGIN_ARTEFACT"

echo "═══ plugin: claude-context (bash, quoted) ═══"
run_case "plugin-claude-context-bash-quoted" \
  bash \
  "curl -fsSL \"${ORIGIN}/api/plugins/install.sh?slug=claude-context&target=claude-code\" | LLM_GATEWAY_API_KEY=\"$API_KEY\" bash" \
  "$CLAUDE_CTX_ARTEFACT"

echo "═══ skill: image-generation (bash, unquoted — reproduce bug) ═══"
run_case "skill-image-generation-bash-unquoted" \
  bash \
  "curl -fsSL ${ORIGIN}/api/skills/install.sh?slug=image-generation&target=claude-code | LLM_GATEWAY_API_KEY=\"$API_KEY\" bash" \
  "$SKILL_IMG_ARTEFACT" negative

echo "═══ skill: image-generation (bash, quoted) ═══"
run_case "skill-image-generation-bash-quoted" \
  bash \
  "curl -fsSL \"${ORIGIN}/api/skills/install.sh?slug=image-generation&target=claude-code\" | LLM_GATEWAY_API_KEY=\"$API_KEY\" bash" \
  "$SKILL_IMG_ARTEFACT"

echo "═══ skill: pick-model (bash, quoted) ═══"
run_case "skill-pick-model-bash-quoted" \
  bash \
  "curl -fsSL \"${ORIGIN}/api/skills/install.sh?slug=pick-model&target=claude-code\" | LLM_GATEWAY_API_KEY=\"$API_KEY\" bash" \
  "$SKILL_PM_ARTEFACT"

# Also re-test under zsh (since many Linux users set it as login shell).
if command -v zsh >/dev/null 2>&1; then
  echo "═══ plugin: supermemory (zsh, unquoted — reproduce bug) ═══"
  run_case "plugin-supermemory-zsh-unquoted" \
    zsh \
    "curl -fsSL ${ORIGIN}/api/plugins/install.sh?slug=supermemory&target=claude-code | LLM_GATEWAY_API_KEY=\"$API_KEY\" bash" \
    "$PLUGIN_ARTEFACT" negative

  echo "═══ plugin: supermemory (zsh, quoted) ═══"
  run_case "plugin-supermemory-zsh-quoted" \
    zsh \
    "curl -fsSL \"${ORIGIN}/api/plugins/install.sh?slug=supermemory&target=claude-code\" | LLM_GATEWAY_API_KEY=\"$API_KEY\" bash" \
    "$PLUGIN_ARTEFACT"
fi

echo ""
echo "═══ post-install state check (plugin-supermemory-bash-quoted) ═══"
# Re-run the quoted install to leave state behind for inspection.
reset_home
bash -c "curl -fsSL \"${ORIGIN}/api/plugins/install.sh?slug=supermemory&target=claude-code\" | LLM_GATEWAY_API_KEY=\"$API_KEY\" bash" >/dev/null 2>&1
if [ -f "$HOME/.claude/settings.json" ]; then
  if grep -q '"supermemory"' "$HOME/.claude/settings.json"; then
    pass "settings.json has mcpServers.supermemory entry"
  else
    fail "settings.json missing mcpServers.supermemory"
    cat "$HOME/.claude/settings.json" | sed 's/^/    /'
  fi
else
  fail "settings.json not written"
fi

if [ -d "$HOME/.claude/plugins/supermemory" ]; then
  pass "plugin source extracted into ~/.claude/plugins/supermemory"
else
  fail "plugin source dir missing"
fi

echo ""
echo "═══ summary ═══"
if [ "$FAILURES" -eq 0 ]; then
  echo -e "\e[32mALL PASSED\e[0m"
else
  echo -e "\e[31m$FAILURES FAILURE(S)\e[0m"
fi
exit "$FAILURES"
