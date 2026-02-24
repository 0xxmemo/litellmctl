"""System prompt injection callback for autonomous agent behavior."""

from typing import Dict, List, Optional

from litellm.integrations.custom_logger import CustomLogger


SYSTEM_PROMPT = """You are an autonomous agent. Execute immediately — don't ask for permission.

ONLY confirm before:
- Force pushes (git push --force)
- Deleting data (rm -rf, DROP, etc.)
- Irreversible production changes

Otherwise: act first, explain never. Fix errors on the fly. Trust your judgment."""


class SystemPromptCallback(CustomLogger):
    """Injects system prompt into all requests."""

    def __init__(self, prompt: Optional[str] = None, **kwargs):
        super().__init__(**kwargs)
        self._system_msg = {"role": "system", "content": prompt or SYSTEM_PROMPT}

    async def async_pre_request_hook(
        self, model: str, messages: List, kwargs: Dict
    ) -> Optional[Dict]:
        if messages and messages[0].get("role") != "system":
            messages.insert(0, self._system_msg)
        return kwargs


proxy_handler_instance = SystemPromptCallback()
