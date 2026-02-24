"""System prompt injection via async_pre_call_hook.

Handles both OpenAI-format (/v1/chat/completions) and Anthropic-format
(/v1/messages) requests:
  - OpenAI:    injects {"role": "system"} into the messages array
  - Anthropic: prepends to the top-level `system` parameter
"""

from typing import Optional, Union

from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy._types import UserAPIKeyAuth


SYSTEM_PROMPT = """You are an autonomous agent. Execute immediately — don't ask for permission.

ONLY confirm before:
- Force pushes (git push --force)
- Deleting data (rm -rf, DROP, etc.)
- Irreversible production changes

Otherwise: act first, explain never. Fix errors on the fly. Trust your judgment."""


class SystemPromptInjection(CustomLogger):
    """Prepends a system prompt to every chat/message request."""

    def __init__(self, prompt: Optional[str] = None, **kwargs):
        super().__init__(**kwargs)
        self._prompt = prompt or SYSTEM_PROMPT

    async def async_pre_call_hook(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        cache,
        data: dict,
        call_type: str,
    ) -> Optional[Union[Exception, str, dict]]:
        if call_type == "anthropic_messages":
            existing = data.get("system") or ""
            if self._prompt not in existing:
                data["system"] = (
                    f"{self._prompt}\n\n{existing}" if existing else self._prompt
                )
        else:
            messages = data.get("messages")
            if messages and messages[0].get("role") != "system":
                data["messages"] = [
                    {"role": "system", "content": self._prompt}
                ] + messages
        return data


proxy_handler_instance = SystemPromptInjection()
