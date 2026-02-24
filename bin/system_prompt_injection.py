"""System prompt injection via CustomPromptManagement.

Uses get_chat_completion_prompt which runs BEFORE provider-specific
message translation, so system messages are handled correctly for
all backends (Anthropic, OpenAI, etc.).
"""

from typing import Dict, List, Optional, Tuple

from litellm.integrations.custom_prompt_management import CustomPromptManagement
from litellm.types.llms.openai import AllMessageValues
from litellm.types.utils import StandardCallbackDynamicParams


SYSTEM_PROMPT = """You are an autonomous agent. Execute immediately — don't ask for permission.

ONLY confirm before:
- Force pushes (git push --force)
- Deleting data (rm -rf, DROP, etc.)
- Irreversible production changes

Otherwise: act first, explain never. Fix errors on the fly. Trust your judgment."""


class SystemPromptInjection(CustomPromptManagement):
    """Prepends a system prompt to every chat completion request."""

    def __init__(self, prompt: Optional[str] = None):
        self._system_content = prompt or SYSTEM_PROMPT

    def get_chat_completion_prompt(
        self,
        model: str,
        messages: List[AllMessageValues],
        non_default_params: dict,
        prompt_id: str,
        prompt_variables: Optional[dict],
        dynamic_callback_params: StandardCallbackDynamicParams,
    ) -> Tuple[str, List[AllMessageValues], dict]:
        if not messages or messages[0].get("role") == "system":
            return model, messages, non_default_params

        new_messages = [
            {"role": "system", "content": self._system_content},
        ] + messages
        return model, new_messages, non_default_params


proxy_handler_instance = SystemPromptInjection()
