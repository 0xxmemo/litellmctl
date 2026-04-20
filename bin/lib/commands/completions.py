"""Shell completion generation and setup."""

from __future__ import annotations

import os
from pathlib import Path

from ..common.formatting import info


# Source of truth for completion word lists — mirrors cli.py (flat command surface).
# If you add a new top-level command, update both this file and cli.py.
_TOP_COMMANDS = (
    "wizard install uninstall init-env "
    "auth "
    "start stop restart status logs proxy local "
    "users set-role routes api migrate-from-mongo "
    "toggle-claude setup-completions help"
)
_FEATURES = "proxy gateway searxng protonmail embedding transcription"
_STATUS_TARGETS = "proxy gateway searxng protonmail embedding transcription auth"
_LOGS_TARGETS = "proxy gateway protonmail searxng"
_AUTH_PROVIDERS = "chatgpt gemini qwen kimi protonmail"
_AUTH_COMMANDS = f"{_AUTH_PROVIDERS} refresh export import status providers"
_UNINSTALL_TARGETS = "service embedding transcription searxng gateway protonmail"
_ROLES = "guest user admin"
_INSTALL_FLAGS = (
    "--with-local --without-local "
    "--with-embedding --without-embedding "
    "--with-transcription --without-transcription "
    "--with-searxng --without-searxng "
    "--with-gateway --without-gateway "
    "--with-protonmail --without-protonmail"
)


BASH_COMPLETIONS = r"""_litellmctl_completions() {
  local cur prev commands features status_targets logs_targets auth_cmds uninstall_cmds roles
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  commands="__TOP_COMMANDS__"
  features="__FEATURES__"
  status_targets="__STATUS_TARGETS__"
  logs_targets="__LOGS_TARGETS__"
  auth_cmds="__AUTH_COMMANDS__"
  auth_providers="__AUTH_PROVIDERS__"
  uninstall_cmds="__UNINSTALL_TARGETS__"
  roles="__ROLES__"

  # `litellmctl api <cmd...>` → dynamic completions from gateway route source files
  local api_pos=-1
  for ((i=0; i<COMP_CWORD; i++)); do
    if [[ "${COMP_WORDS[i]}" == "api" && i -eq 1 ]]; then
      api_pos=$i
      break
    fi
  done
  if [[ $api_pos -ge 0 ]]; then
    local segs=""
    for ((i=api_pos+1; i<COMP_CWORD; i++)); do
      segs="$segs ${COMP_WORDS[i]}"
    done
    local suggestions
    suggestions=$(python3 -c "
import sys; sys.path.insert(0, '$HOME/.litellm/bin')
from lib.commands.gateway import _completable_segments
print(' '.join(_completable_segments([s for s in '''$segs'''.split() if s])))" 2>/dev/null)
    COMPREPLY=( $(compgen -W "$suggestions" -- "$cur") )
    return
  fi

  case "$prev" in
    litellmctl)
      COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
      return ;;
    auth)
      COMPREPLY=( $(compgen -W "$auth_cmds" -- "$cur") )
      return ;;
    refresh|export)
      COMPREPLY=( $(compgen -W "$auth_providers" -- "$cur") )
      return ;;
    start|stop|restart)
      COMPREPLY=( $(compgen -W "$features --port --config" -- "$cur") )
      return ;;
    status)
      COMPREPLY=( $(compgen -W "$status_targets" -- "$cur") )
      return ;;
    logs)
      COMPREPLY=( $(compgen -W "$logs_targets" -- "$cur") )
      return ;;
    set-role)
      # After `set-role <email>`, suggest roles (for arg #2); otherwise no completion
      return ;;
    proxy)
      COMPREPLY=( $(compgen -W "--port --config" -- "$cur") )
      return ;;
    install)
      COMPREPLY=( $(compgen -W "__INSTALL_FLAGS__" -- "$cur") )
      return ;;
    uninstall)
      COMPREPLY=( $(compgen -W "$uninstall_cmds" -- "$cur") )
      return ;;
    migrate-from-mongo)
      COMPREPLY=( $(compgen -W "--mongo-uri --force" -- "$cur") )
      return ;;
  esac

  # `set-role <email> <role>` — role completion (third word)
  if [[ "${COMP_WORDS[1]}" == "set-role" && $COMP_CWORD -eq 3 ]]; then
    COMPREPLY=( $(compgen -W "$roles" -- "$cur") )
    return
  fi
}
complete -F _litellmctl_completions litellmctl"""


ZSH_COMPLETIONS = r'''_litellmctl_completions() {
  local -a commands auth_cmds uninstall_cmds
  commands=(
    'wizard:Interactive config.yaml generator'
    'install:Install / rebuild LiteLLM'
    'uninstall:Stop and remove components'
    'init-env:Detect auth files and update .env paths'
    'auth:Manage OAuth tokens + protonmail bridge'
    'start:Start features (proxy, gateway, searxng, ...)'
    'stop:Stop features'
    'restart:Restart features'
    'status:Show status for one feature (default: all)'
    'logs:Tail logs for one feature (default: proxy)'
    'proxy:Start proxy in foreground (debug)'
    'local:Check local inference server reachability'
    'users:List gateway users'
    'set-role:Set a gateway user role'
    'routes:List gateway API endpoints'
    'api:Call a gateway API endpoint (bypasses auth)'
    'migrate-from-mongo:One-shot migration from legacy MongoDB to SQLite'
    'toggle-claude:Toggle Claude Code between direct API and proxy'
    'setup-completions:Add litellmctl to your shell'
    'help:Show help'
  )
  auth_cmds=(
    'chatgpt:Login to ChatGPT/Codex'
    'gemini:Login to Gemini CLI'
    'qwen:Login to Qwen Portal'
    'kimi:Login to Kimi Code'
    'protonmail:Authenticate hydroxide SMTP bridge'
    'refresh:Refresh existing token'
    'status:Show token status'
    'export:Copy credentials as transfer script'
    'import:Read credentials from stdin'
    'providers:List available providers'
  )
  uninstall_cmds=(
    'service:Stop and remove the proxy service'
    'embedding:Uninstall Ollama embedding server'
    'transcription:Uninstall transcription server'
    'searxng:Uninstall SearXNG'
    'gateway:Uninstall the gateway UI'
    'protonmail:Uninstall hydroxide SMTP bridge'
  )

  if (( CURRENT == 2 )); then
    _describe 'command' commands
  elif (( CURRENT == 3 )); then
    case "${words[2]}" in
      auth)           _describe 'auth command' auth_cmds ;;
      uninstall)      compadd __UNINSTALL_TARGETS__ ;;
      start|stop|restart) compadd __FEATURES__ -- --port --config ;;
      status)         compadd __STATUS_TARGETS__ ;;
      logs)           compadd __LOGS_TARGETS__ ;;
      proxy)          compadd -- --port --config ;;
      install)        compadd -- __INSTALL_FLAGS__ ;;
      migrate-from-mongo) compadd -- --mongo-uri --force ;;
      api)
        local -a segs
        segs=(${(f)"$(python3 -c "
import sys; sys.path.insert(0, '$HOME/.litellm/bin')
from lib.commands.gateway import _completable_segments
print('\n'.join(_completable_segments([])))" 2>/dev/null)"})
        compadd -- $segs
        ;;
    esac
  elif (( CURRENT == 4 )); then
    case "${words[2]}" in
      auth)
        case "${words[3]}" in
          refresh|export) compadd __AUTH_PROVIDERS__ ;;
        esac
        ;;
      set-role) compadd __ROLES__ ;;
    esac
  elif (( CURRENT >= 4 )); then
    # litellmctl api <seg1> <seg2...> → complete deeper segments
    if [[ "${words[2]}" == "api" ]]; then
      local prefix_str="${(j: :)words[3,CURRENT-1]}"
      local -a segs
      segs=(${(f)"$(python3 -c "
import sys; sys.path.insert(0, '$HOME/.litellm/bin')
from lib.commands.gateway import _completable_segments
print('\n'.join(_completable_segments('$prefix_str'.split())))" 2>/dev/null)"})
      compadd -- $segs
    fi
  fi
}
compdef _litellmctl_completions litellmctl'''


def _substitute(template: str) -> str:
    return (
        template
        .replace("__TOP_COMMANDS__", _TOP_COMMANDS)
        .replace("__FEATURES__", _FEATURES)
        .replace("__STATUS_TARGETS__", _STATUS_TARGETS)
        .replace("__LOGS_TARGETS__", _LOGS_TARGETS)
        .replace("__AUTH_COMMANDS__", _AUTH_COMMANDS)
        .replace("__AUTH_PROVIDERS__", _AUTH_PROVIDERS)
        .replace("__UNINSTALL_TARGETS__", _UNINSTALL_TARGETS)
        .replace("__ROLES__", _ROLES)
        .replace("__INSTALL_FLAGS__", _INSTALL_FLAGS)
    )


def generate_completions() -> str:
    return _substitute(BASH_COMPLETIONS)


def generate_zsh_completions() -> str:
    return _substitute(ZSH_COMPLETIONS)


def cmd_setup_completions() -> None:
    shell_name = os.path.basename(os.environ.get("SHELL", "/bin/bash"))
    if shell_name == "zsh":
        rc_file = Path.home() / ".zshrc"
    else:
        rc_file = Path.home() / ".bashrc"

    if rc_file.exists() and "alias litellmctl=" in rc_file.read_text():
        info(f"litellmctl already set up in {rc_file}")
        return

    if shell_name == "zsh":
        block = '''
# LiteLLM CLI
alias litellmctl="~/.litellm/bin/litellmctl"
eval "$(~/.litellm/bin/litellmctl --zsh-completions)"'''
    else:
        block = '''
# LiteLLM CLI
alias litellmctl="~/.litellm/bin/litellmctl"
eval "$(~/.litellm/bin/litellmctl --completions)"'''

    with rc_file.open("a") as f:
        f.write(block + "\n")
    info(f"Added litellmctl alias + tab completion to {rc_file}")
    info("Open a new terminal to activate (or: exec $SHELL -l)")
