# LLM Gateway — 5-Minute Quickstart

> **Live gateway:** https://llm.0xmemo.com  
> **OpenAI + Anthropic formats** · **35 models** · **7 providers** · **Smart fallbacks**

---

## LiteLLM Proxy — Format Agnostic

LiteLLM handles **automatic format transformation** — use any format with any model:
- ✅ Use OpenAI format (`/v1/chat/completions`) with Anthropic models → returns OpenAI response
- ✅ Use Anthropic format (`/v1/messages`) with OpenAI models → returns Anthropic response
- ✅ Response format **always matches your request format**, regardless of internal model
- ✅ Internal model routing is fully abstracted

**Example:**
```bash
# OpenAI format + Anthropic model → OpenAI response
curl -X POST https://llm.0xmemo.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4-6", "messages": [{"role": "user", "content": "Hi"}]}'
# Returns: OpenAI format { choices: [...], delta: {...} }

# Anthropic format + OpenAI model → Anthropic response
curl -X POST https://llm.0xmemo.com/v1/messages \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hi"}]}'
# Returns: Anthropic format { content: [...], role: "..." }
```

---

## Step 1: Get Access

1. Go to **https://llm.0xmemo.com**
2. Enter your email → receive a 6-digit OTP code
3. Verify the OTP → you become a **guest**
4. Wait for admin approval → you become a **user**

> Approval is typically granted within a few hours. You'll be able to create API keys once approved.

---

## Step 2: Create an API Key

1. Log in at https://llm.0xmemo.com
2. Navigate to **API Keys** in the sidebar
3. Click **Create Key** → give it a name
4. Copy your key immediately — it starts with `llm_` and is shown **once**

---

## API Endpoints

### Chat Completions

**OpenAI Format:**
```bash
curl -X POST https://llm.0xmemo.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

**Anthropic Format:**
```bash
curl -X POST https://llm.0xmemo.com/v1/messages \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

### Embeddings

```bash
curl -X POST https://llm.0xmemo.com/v1/embeddings \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "text-embedding-3-small",
    "input": "Text to embed"
  }'
```

### Vision

**OpenAI:**
```bash
curl -X POST https://llm.0xmemo.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "What is in this image?"},
        {"type": "image_url", "image_url": {"url": "https://..."}}
      ]
    }]
  }'
```

**Anthropic:**
```bash
curl -X POST https://llm.0xmemo.com/v1/messages \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "What is in this image?"},
        {"type": "image", "source": {"type": "url", "url": "https://..."}}
      ]
    }]
  }'
```

---

## Architecture

All requests are forwarded directly to **LiteLLM**, which handles:
- Format normalization (OpenAI ↔ Anthropic)
- Model routing
- Rate limiting
- Response caching

**Use native formats** for each provider. Don't mix OpenAI format with Anthropic models or vice versa.

---

## Step 3: Use Model Aliases

Three aliases give you the best model for the job, with automatic fallbacks if the primary is unavailable:

| Alias | Primary Model | Best For | Fallback Chain |
|-------|--------------|----------|----------------|
| `opus` | `codex/gpt-5.3-codex` | Complex reasoning, hard problems | qwen3.5-plus → kimi → **claude-opus-4-6** → glm-5 → gemini-2.5-pro → minimax |
| `sonnet` | `anthropic/claude-sonnet-4-6` | Most tasks — best balance | gpt-5.3-codex-spark → qwen3-coder-plus → glm-4.5-air → kimi → gemini-2.5-flash |
| `haiku` | `codex/gpt-5.1-codex-mini` | Fast, cheap, simple tasks | qwen3-vl-plus → qwen3-coder-next → **claude-haiku-4-5** → glm-4.5-flash → gemini-flash-lite |

**Anthropic models are integrated as fallbacks** in the `opus` and `haiku` chains for reliability.

```bash
# Fastest + cheapest
curl -X POST https://llm.0xmemo.com/v1/chat/completions \
  -H "Authorization: Bearer llm_YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"model": "haiku", "messages": [{"role": "user", "content": "Summarize in 1 sentence: The sky is blue."}]}'
```

---

## Step 4: Enable Streaming

```bash
curl -X POST https://llm.0xmemo.com/v1/chat/completions \
  -H "Authorization: Bearer llm_YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "stream": true,
    "messages": [{"role": "user", "content": "Count from 1 to 5"}]
  }'
```

Responses are streamed as `text/event-stream` in OpenAI SSE format.

---

## SDK Integration

### Python (openai library)

```python
from openai import OpenAI

client = OpenAI(
    api_key="llm_YOUR_KEY_HERE",
    base_url="https://llm.0xmemo.com/v1"
)

response = client.chat.completions.create(
    model="sonnet",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

### TypeScript / JavaScript

```typescript
const response = await fetch('https://llm.0xmemo.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer llm_YOUR_KEY_HERE',
  },
  body: JSON.stringify({
    model: 'sonnet',
    messages: [{ role: 'user', content: 'Hello!' }],
  }),
})

const data = await response.json()
console.log(data.choices[0].message.content)
```

### LangChain

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="sonnet",
    openai_api_key="llm_YOUR_KEY_HERE",
    openai_api_base="https://llm.0xmemo.com/v1"
)

response = llm.invoke("Hello!")
print(response.content)
```

---

## Available Models

### Aliases (Recommended)

| Alias | Routes To | Fallbacks | Includes Anthropic |
|-------|-----------|-----------|---------------------|
| `opus` | `codex/gpt-5.3-codex` | 6 fallbacks | ✅ claude-opus-4-6 |
| `sonnet` | `anthropic/claude-sonnet-4-6` | 7 fallbacks | ✅ Primary is Anthropic |
| `haiku` | `codex/gpt-5.1-codex-mini` | 6 fallbacks | ✅ claude-haiku-4-5 |

### OpenAI / Codex (GPT-5 via OpenAI Responses API)

| Model ID | Alias | Context | Best For |
|----------|-------|---------|----------|
| `codex/gpt-5.3-codex` | `opus` | 128K | Complex reasoning, hard problems |
| `codex/gpt-5.3-codex-spark` | sonnet fallback | 128K | Balanced performance |
| `codex/gpt-5.1-codex-mini` | `haiku` | 128K | Fast, cheap, simple tasks |
| `codex/gpt-5.2-codex` | — | 128K | General purpose |
| `codex/gpt-5.1-codex` | — | 128K | General purpose |
| `codex/gpt-5.2` | — | 128K | General purpose |
| `codex/gpt-5.1` | — | 128K | General purpose |
| `gpt-4o` | — | 128K | Vision, general |

**Example (alias — auto-fallback):**
```bash
# "opus" alias → routes to codex/gpt-5.3-codex with 6 fallbacks
curl -X POST https://llm.0xmemo.com/v1/chat/completions \
  -H "Authorization: Bearer llm_YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"model": "opus", "messages": [{"role": "user", "content": "Explain quantum entanglement."}]}'
```

### Anthropic Claude

| Model ID | Notes |
|----------|-------|
| `claude-opus-4-6` | Best reasoning · use with `/v1/messages` |
| `claude-sonnet-4-6` | `sonnet` primary · balanced · use with `/v1/messages` |
| `claude-haiku-4-5` | Fastest · use with `/v1/messages` |

**All Anthropic models support:**
- ✅ Streaming responses
- ✅ Function/tool calling
- ✅ Vision (images in messages)
- ✅ 200K context window
- ✅ JSON mode

### Gemini CLI

| Model ID | Notes |
|----------|-------|
| `gemini-cli/gemini-2.5-pro` | Best Gemini, 1M context |
| `gemini-cli/gemini-2.5-flash` | Fast Gemini |
| `gemini-cli/gemini-2.5-flash-lite` | Lightest Gemini |

### Alibaba / Qwen

| Model ID | Timeout | Notes |
|----------|---------|-------|
| `alibaba/qwen3.5-plus` | 90s | `opus` fallback |
| `alibaba/qwen3-coder-plus` | 90s | `sonnet` fallback |
| `alibaba/qwen3-coder-next` | 60s | `haiku` fallback |
| `qwen-cli/qwen3-coder-plus` | — | Portal-based |
| `qwen-cli/qwen3-vl-plus` | — | Vision, `haiku` fallback |

### Kimi / MiniMax

| Model ID | Provider |
|----------|----------|
| `kimi-code/kimi-for-coding` | Moonshot AI |
| `minimax/MiniMax-M2.5-highspeed` | MiniMax |

### ZAI / GLM (13 models)

| Model ID | Notes |
|----------|-------|
| `zai/glm-5` | `opus` fallback |
| `zai/glm-4.5` | |
| `zai/glm-4.5-air` | `sonnet` fallback |
| `zai/glm-4.5-flash` | `haiku` fallback |
| `zai/glm-4.5v` | Vision |
| `zai/glm-4.6` | |
| `zai/glm-4.6v` | Vision |
| `zai/glm-4.7` | |
| `zai/glm-4.7-flash` | |
| `zai/glm-4.7-flashx` | Ultra-fast |
| `zai/glm-5v` | Vision |
| `zai/glm-5-flash` | Fast |

**Total: 35 models · 7 providers**

---

## API Reference

### Authentication

Two supported header formats:

```
Authorization: Bearer llm_YOUR_KEY_HERE
```
or
```
x-api-key: llm_YOUR_KEY_HERE
```

### POST /v1/chat/completions

Standard OpenAI-compatible chat completions.

**Request:**
```json
{
  "model": "sonnet",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "max_tokens": 1024,
  "temperature": 0.7,
  "stream": false
}
```

**Response:**
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "anthropic/claude-sonnet-4-6",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "Hello! How can I help you?"},
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 12, "completion_tokens": 9, "total_tokens": 21}
}
```

### POST /v1/messages

Anthropic-native chat completions.

**Request:**
```json
{
  "model": "claude-sonnet-4-6",
  "messages": [
    {"role": "user", "content": "Hello!"}
  ],
  "max_tokens": 1024
}
```

### GET /v1/models

List all available models.

```bash
curl https://llm.0xmemo.com/v1/models \
  -H "Authorization: Bearer llm_YOUR_KEY_HERE"
```

### POST /v1/embeddings

Generate vector embeddings (model must support embeddings).

```bash
curl -X POST https://llm.0xmemo.com/v1/embeddings \
  -H "Authorization: Bearer llm_YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{"model": "text-embedding-3-small", "input": "Your text here"}'
```

---

## Audio Transcription

**Local Whisper model** — runs on-device, no external API key needed.

### Upload (multipart/form-data)

```bash
curl -X POST https://llm.0xmemo.com/v1/audio/transcriptions \
  -H "Authorization: Bearer llm_YOUR_KEY_HERE" \
  -F "file=@recording.webm" \
  -F "model=whisper/base"
```

### Base64 (JSON)

```bash
curl -X POST https://llm.0xmemo.com/v1/audio/transcriptions/base64 \
  -H "Authorization: Bearer llm_YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "audio_base64": "UklGRi...",
    "model": "whisper/base",
    "format": "webm"
  }'
```

### Response

```json
{
  "text": "Transcribed text here...",
  "language": "en",
  "duration": 0,
  "model": "whisper/base",
  "segments": []
}
```

**Models:** `whisper/base` (74MB, fast), `whisper/small` (244MB), `whisper/medium` (769MB, most accurate)  
**Formats:** WAV, MP3, FLAC, WebM, M4A (max 20MB)  
**Privacy:** All processing is local — no audio leaves your server.

---

## Key Management

All key endpoints require **session auth** (log in to the dashboard, not an API key):

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/keys` | Create a new API key |
| `GET` | `/api/keys` | List your API keys |
| `DELETE` | `/api/keys/:id` | Revoke an API key |

---

## Error Codes

| Status | Meaning | Fix |
|--------|---------|-----|
| `401` | Missing or invalid API key | Add `Authorization: Bearer llm_YOUR_KEY_HERE` |
| `403` | Insufficient role (guest) | Wait for admin approval |
| `429` | Rate limit exceeded | Wait and retry |
| `500` | Server/provider error | Retry — automatic fallback may resolve it |
| `502` | LiteLLM proxy error | Check model name, retry |

---

## Router Behavior

The gateway uses LiteLLM's router with these settings:

| Setting | Value |
|---------|-------|
| Retries | 2 per request |
| Timeout | 120 seconds |
| Retry after | 1 second |
| Max fails before cooldown | 3 |
| Cooldown time | 15 seconds |
| Strategy | Simple shuffle (load balancing) |
| Response caching | 300 seconds TTL (local) |

---

## Health Check

```bash
curl https://llm.0xmemo.com/api/health
# → {"status":"healthy","timestamp":"...","database":"connected"}
```

---

## Support

- **Email:** 0xmemo@pm.me
- **Dashboard:** https://llm.0xmemo.com
