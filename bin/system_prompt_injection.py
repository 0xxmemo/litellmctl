"""System prompt injection via async_pre_call_hook.

Currently a scaffold - no injection logic is applied.
Can be extended in the future to inject system prompts for specific providers.
"""

from typing import Optional, Union

from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy._types import UserAPIKeyAuth


class SystemPromptInjection(CustomLogger):
    """Scaffold for system prompt injection. Currently a no-op."""

    def __init__(self, prompt: Optional[str] = None, **kwargs):
        super().__init__(**kwargs)
        self._prompt = prompt

    async def async_pre_call_hook(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        cache,
        data: dict,
        call_type: str,
    ) -> Optional[Union[Exception, str, dict]]:
        """No-op hook - returns data unchanged."""
        return data


proxy_handler_instance = SystemPromptInjection()
