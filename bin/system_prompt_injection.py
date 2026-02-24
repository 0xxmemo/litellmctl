"""System prompt injection via async_pre_call_hook.

Uses the proxy-level pre-call hook which runs BEFORE provider-specific
message translation, so LiteLLM correctly converts system messages
to the top-level `system` param for Anthropic, etc.
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
    """Prepends a system prompt to every chat completion request."""

    def __init__(self, prompt: Optional[str] = None, **kwargs):
        super().__init__(**kwargs)
        self._system_msg = {"role": "system", "content": prompt or SYSTEM_PROMPT}

    async def async_pre_call_hook(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        cache,
        data: dict,
        call_type: str,
    ) -> Optional[Union[Exception, str, dict]]:
        messages = data.get("messages")
        if messages and messages[0].get("role") != "system":
            data["messages"] = [self._system_msg] + messages
        return data


proxy_handler_instance = SystemPromptInjection()
