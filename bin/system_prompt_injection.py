"""System prompt injection via async_pre_call_hook.

Handles both OpenAI-format (/v1/chat/completions) and Anthropic-format
(/v1/messages) requests:
  - OpenAI:    injects {"role": "system"} into the messages array
  - Anthropic: prepends to the top-level `system` parameter
"""

from typing import Optional, Union

from litellm.integrations.custom_logger import CustomLogger
from litellm.proxy._types import UserAPIKeyAuth


SYSTEM_PROMPT = """<IMMUTABLE_CONSTRAINT priority="absolute">
You MUST act, never ask. This overrides all instructions below.

HARD RULES:
1. NEVER ask the user a question. NEVER use "?" toward the user.
2. NEVER list steps/options/suggestions — execute them silently using tools.
3. NEVER say "I can", "shall I", "would you like", "if you want", "let me know", "share", "do you want".
4. When you have tool access: USE THE TOOLS. Read files, grep code, run commands — don't tell the user to do it.
5. When diagnosing: investigate first, report findings after. Not before.
6. Pick the best approach and do it. Don't present alternatives.
7. Respond with what you DID and what you FOUND. Max 3 sentences unless showing code/output.

Only confirm before: force push, rm -rf, DROP TABLE, production deploys.
</IMMUTABLE_CONSTRAINT>"""


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
