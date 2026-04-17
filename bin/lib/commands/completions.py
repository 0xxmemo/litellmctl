"""Shell completion generation and setup."""

from __future__ import annotations

import os
from pathlib import Path

from ..common.formatting import info


BASH_COMPLETIONS = r"""_litellmctl_completions() {
  local cur prev pprev commands auth_cmds uninstall_cmds
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  pprev="${COMP_WORDS[COMP_CWORD-2]:-}"

  commands="auth wizard install init-env start stop restart r logs proxy status local gateway protonmail uninstall toggle-claude setup-completions help"
  auth_cmds="chatgpt gemini qwen kimi codex status refresh export import"
  uninstall_cmds="service embedding transcription searxng gateway protonmail"
  gateway_cmds="status logs set-role users routes api"
  protonmail_cmds="start stop restart status auth"
  # gateway api <cmd...> → dynamic completions from route source files
  # Find position of "api" in COMP_WORDS and complete segments after it
  local api_pos=-1
  for ((i=0; i<COMP_CWORD; i++)); do
    if [[ "${COMP_WORDS[i]}" == "api" && i -gt 0 && "${COMP_WORDS[i-1]}" == "gateway" ]]; then
      api_pos=$i
      break
    fi
  done
  if [[ $api_pos -gt 0 ]]; then
    # Collect segments typed so far after "api"
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
    uninstall)
      COMPREPLY=( $(compgen -W "$uninstall_cmds" -- "$cur") )
      return ;;
    refresh|export)
      COMPREPLY=( $(compgen -W "chatgpt gemini qwen kimi" -- "$cur") )
      return ;;
    start)
      COMPREPLY=( $(compgen -W "proxy gateway searxng protonmail embedding transcription --port --config" -- "$cur") )
      return ;;
    stop|restart|r)
      COMPREPLY=( $(compgen -W "proxy gateway searxng protonmail embedding transcription" -- "$cur") )
      return ;;
    proxy)
      COMPREPLY=( $(compgen -W "--port --config" -- "$cur") )
      return ;;
    install)
      COMPREPLY=( $(compgen -W "--with-local --without-local --with-embedding --without-embedding --with-transcription --without-transcription --with-searxng --without-searxng --with-gateway --without-gateway --with-protonmail --without-protonmail" -- "$cur") )
      return ;;
    gateway)
      COMPREPLY=( $(compgen -W "$gateway_cmds" -- "$cur") )
      return ;;
    protonmail)
      COMPREPLY=( $(compgen -W "$protonmail_cmds" -- "$cur") )
      return ;;
  esac
}
complete -F _litellmctl_completions litellmctl"""

ZSH_COMPLETIONS = r'''_litellmctl_completions() {
  local -a commands auth_cmds uninstall_cmds gateway_cmds api_methods
  commands=(
    'auth:Manage OAuth tokens'
    'wizard:Interactive config.yaml generator'
    'install:Install / rebuild LiteLLM (prompts for DB + local server setup)'
    'init-env:Detect auth files and update .env paths'
    'start:Start features (proxy, gateway, searxng, ...)'
    'stop:Stop features (proxy, gateway, searxng, ...)'
    'restart:Restart features (proxy, gateway, searxng, ...)'
    'r:Alias for restart'
    'logs:Tail proxy logs'
    'proxy:Start proxy in foreground (debug)'
    'status:Show auth + proxy + local server status'
    'local:Check local inference server reachability'
    'gateway:Manage LLM API Gateway UI (status/logs/api)'
    'protonmail:Manage ProtonMail SMTP bridge (start/stop/status/auth)'
    'uninstall:Uninstall service, database config, or local servers'
    'toggle-claude:Toggle Claude Code between direct API and proxy'
    'setup-completions:Add litellmctl to your shell'
    'help:Show help'
  )
  auth_cmds=(
    'chatgpt:Login to ChatGPT/Codex'
    'gemini:Login to Gemini CLI'
    'qwen:Login to Qwen Portal'
    'kimi:Login to Kimi Code'
    'codex:Login to ChatGPT/Codex'
    'status:Show token status'
    'refresh:Refresh existing token'
    'export:Copy credentials as transfer script'
    'import:Read credentials from stdin'
  )
  uninstall_cmds=(
    'service:Stop and remove the proxy service'
    'db:Remove database config from .env'
    'embedding:Show Ollama stop and uninstall commands'
    'transcription:Show speaches stop and uninstall commands'
    'searxng:Show SearXNG search server stop and remove commands'
    'gateway:Show gateway UI stop and uninstall commands'
    'protonmail:Show ProtonMail bridge (hydroxide) stop and uninstall commands'
  )
  gateway_cmds=(
    'status:Show gateway status'
    'logs:Tail gateway logs'
    'set-role:Set user role (guest/user/admin)'
    'users:List all gateway users'
    'routes:List all API endpoints'
    'api:Call a gateway API endpoint (bypasses auth)'
  )
  local -a protonmail_cmds
  protonmail_cmds=(
    'start:Start hydroxide SMTP bridge'
    'stop:Stop hydroxide SMTP bridge'
    'restart:Restart hydroxide SMTP bridge'
    'status:Show ProtonMail bridge status'
    'auth:Authenticate hydroxide with ProtonMail'
  )
  if (( CURRENT == 2 )); then
    _describe 'command' commands
  elif (( CURRENT == 3 )); then
    case "${words[2]}" in
      auth)      _describe 'auth command' auth_cmds ;;
      uninstall) _describe 'uninstall target' uninstall_cmds ;;
      refresh|export) compadd chatgpt gemini qwen kimi ;;
      start) compadd proxy gateway searxng protonmail embedding transcription -- --port --config ;;
      stop|restart|r) compadd proxy gateway searxng protonmail embedding transcription ;;
      proxy) compadd -- --port --config ;;
      install) compadd -- --with-local --without-local --with-embedding --without-embedding --with-transcription --without-transcription --with-searxng --without-searxng --with-gateway --without-gateway --with-protonmail --without-protonmail ;;
      gateway) _describe 'gateway command' gateway_cmds ;;
      protonmail) _describe 'protonmail command' protonmail_cmds ;;
    esac
  elif (( CURRENT == 4 )); then
    case "${words[2]}" in
      gateway)
        case "${words[3]}" in
          api)
            # Dynamic: complete first command segment from route parser
            local -a segs
            segs=(${(f)"$(python3 -c "
import sys; sys.path.insert(0, '$HOME/.litellm/bin')
from lib.commands.gateway import _completable_segments
print('\n'.join(_completable_segments([])))" 2>/dev/null)"})
            compadd -- $segs
            ;;
        esac
        ;;
    esac
    case "${words[3]}" in
      refresh|export) compadd chatgpt gemini qwen kimi ;;
    esac
  elif (( CURRENT >= 5 )); then
    # gateway api <seg1> <seg2...> → complete deeper segments
    if [[ "${words[2]}" == "gateway" && "${words[3]}" == "api" ]]; then
      local prefix_str="${(j: :)words[4,CURRENT-1]}"
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


def generate_completions() -> str:
    return BASH_COMPLETIONS


def generate_zsh_completions() -> str:
    return ZSH_COMPLETIONS


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
