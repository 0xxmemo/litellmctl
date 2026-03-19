"""Shell completion generation and setup."""

from __future__ import annotations

import os
from pathlib import Path

from ..common.formatting import info


BASH_COMPLETIONS = r'''_litellmctl_completions() {
  local cur prev commands auth_cmds uninstall_cmds
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  commands="auth wizard install init-env start stop restart r logs proxy status local gateway uninstall toggle-claude setup-completions help"
  auth_cmds="chatgpt gemini qwen kimi codex status refresh export import"
  uninstall_cmds="service db embedding transcription searxng gateway protonmail"
  gateway_cmds="start stop restart status logs set-role users"

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
    start|proxy)
      COMPREPLY=( $(compgen -W "--port --config" -- "$cur") )
      return ;;
    install)
      COMPREPLY=( $(compgen -W "--with-db --without-db --with-local --without-local --with-embedding --without-embedding --with-transcription --without-transcription --with-searxng --without-searxng --with-gateway --without-gateway --with-protonmail --without-protonmail" -- "$cur") )
      return ;;
    gateway)
      COMPREPLY=( $(compgen -W "$gateway_cmds" -- "$cur") )
      return ;;
  esac
}
complete -F _litellmctl_completions litellmctl'''

ZSH_COMPLETIONS = r'''_litellmctl_completions() {
  local -a commands auth_cmds uninstall_cmds
  commands=(
    'auth:Manage OAuth tokens'
    'wizard:Interactive config.yaml generator'
    'install:Install / rebuild LiteLLM (prompts for DB + local server setup)'
    'init-env:Detect auth files and update .env paths'
    'start:Start proxy as background service'
    'stop:Stop the proxy service'
    'restart:Restart the proxy service'
    'r:Alias for restart'
    'logs:Tail proxy logs'
    'proxy:Start proxy in foreground (debug)'
    'status:Show auth + proxy + local server status'
    'local:Check local inference server reachability'
    'gateway:Manage LLM API Gateway UI (start/stop/status)'
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
    'transcription:Show faster-whisper-server stop and uninstall commands'
    'searxng:Show SearXNG search server stop and remove commands'
    'gateway:Show gateway UI stop and uninstall commands'
    'protonmail:Show ProtonMail bridge (hydroxide) stop and uninstall commands'
  )

  if (( CURRENT == 2 )); then
    _describe 'command' commands
  elif (( CURRENT == 3 )); then
    case "${words[2]}" in
      auth)      _describe 'auth command' auth_cmds ;;
      uninstall) _describe 'uninstall target' uninstall_cmds ;;
      refresh|export) compadd chatgpt gemini qwen kimi ;;
      start|proxy) compadd -- --port --config ;;
      install) compadd -- --with-db --without-db --with-local --without-local --with-embedding --without-embedding --with-transcription --without-transcription --with-searxng --without-searxng --with-gateway --without-gateway --with-protonmail --without-protonmail ;;
      gateway) compadd start stop restart status logs set-role users ;;
    esac
  elif (( CURRENT == 4 )); then
    case "${words[3]}" in
      refresh|export) compadd chatgpt gemini qwen kimi ;;
    esac
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
