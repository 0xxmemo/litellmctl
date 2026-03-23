"""System prompt injection via async_pre_call_hook.

Only targets alibaba/ models. Handles both OpenAI-format
(/v1/chat/completions) and Anthropic-format (/v1/messages) requests:
  - OpenAI:    injects {"role": "system"} into the messages array
  - Anthropic: prepends to the top-level `system` parameter

Also strips system messages from chatgpt/ models (they reject system messages).
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

_TARGET_PREFIXES = ("alibaba/",)
_CHATGPT_PREFIXES = ("chatgpt/", "codex/")


class SystemPromptInjection(CustomLogger):
    """Prepends a system prompt to alibaba/ model requests only.

    Also strips system messages from chatgpt/ models (they reject system messages).
    """

    def __init__(self, prompt: Optional[str] = None, **kwargs):
        super().__init__(**kwargs)
        self._prompt = prompt or SYSTEM_PROMPT

    def _is_target_model(self, data: dict) -> bool:
        model = data.get("model") or ""
        return any(model.startswith(p) for p in _TARGET_PREFIXES)

    def _is_chatgpt_model(self, data: dict) -> bool:
        model = data.get("model") or ""
        return any(model.startswith(p) for p in _CHATGPT_PREFIXES)

    async def async_pre_call_hook(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        cache,
        data: dict,
        call_type: str,
    ) -> Optional[Union[Exception, str, dict]]:
        # Strip system messages from chatgpt/ models (they reject system messages)
        if self._is_chatgpt_model(data):
            messages = data.get("messages")
            if messages:
                data["messages"] = [m for m in messages if m.get("role") != "system"]
            # Also remove top-level system key if present
            data.pop("system", None)
            return data

        if not self._is_target_model(data):
            return data

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
