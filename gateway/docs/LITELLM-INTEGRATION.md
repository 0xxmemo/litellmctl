# LiteLLM Integration Guide

The LLM API Gateway proxies all chat completion requests through a [LiteLLM](https://docs.litellm.ai/) proxy. This gives you a unified OpenAI-compatible API that supports 35+ models across 7 providers without changing your client code.

---

## Architecture

```
Client
  → https://llm.0xmemo.com/v1/chat/completions
    → Caddy (TLS termination, port 443)
      → Hono backend (port 3001) — API key validation
        → LiteLLM proxy (port 4000)
          → Provider (Anthropic / Codex / Gemini / Qwen / Kimi / MiniMax / ZAI)
```

The gateway:
1. Accepts requests at `/v1/chat/completions`
2. Validates the caller's API key (bcrypt-hashed in MongoDB)
3. Forwards the full request body to LiteLLM with the master key
4. Returns the response (or streams it) back to the client

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LITELLM_PROXY_URL` | ✅ | `http://localhost:4000` | LiteLLM proxy base URL |
| `LITELLM_MASTER_KEY` | ✅ | — | LiteLLM master key |
| `MONGODB_URI` | ✅ | — | MongoDB connection string |
| `SESSION_SECRET` | ✅ | — | Session signing secret (32+ chars) |
| `ADMIN_EMAIL` | ✅ | — | Admin email for notifications |
| `ADMIN_PASSWORD` | ✅ | — | Admin Basic Auth password |

---

## LiteLLM Configuration (`/home/ubuntu/.litellm/config.yaml`)

### Configured Models (35 total)

#### Model Aliases (use these for simplicity)

| Alias | Primary Model | Fallbacks |
|-------|-------------|-----------|
| `opus` | `codex/gpt-5.3-codex` | alibaba/qwen3.5-plus → kimi-code → claude-opus-4-6 → glm-5 → gemini-2.5-pro → minimax |
| `sonnet` | `anthropic/claude-sonnet-4-6` | gpt-5.3-codex-spark → qwen3-coder → alibaba/qwen3-coder-plus → glm-4.5-air → kimi-code → gemini-2.5-flash → minimax |
| `haiku` | `codex/gpt-5.1-codex-mini` | qwen3-vl-plus → alibaba/qwen3-coder-next → claude-haiku-4-5 → glm-4.5-flash → gemini-2.5-flash-lite → minimax |

#### All Models

**Codex / GPT-5** (via OpenAI Responses API):
- `codex/gpt-5.3-codex`, `codex/gpt-5.3-codex-spark`, `codex/gpt-5.1-codex-mini`
- `codex/gpt-5.2-codex`, `codex/gpt-5.1-codex`, `codex/gpt-5.2`, `codex/gpt-5.1`

**Anthropic Claude**:
- `anthropic/claude-opus-4-6`, `anthropic/claude-sonnet-4-6`, `anthropic/claude-haiku-4-5`

**Gemini CLI**:
- `gemini-cli/gemini-2.5-pro`, `gemini-cli/gemini-2.5-flash`, `gemini-cli/gemini-2.5-flash-lite`

**Alibaba / Qwen**:
- `alibaba/qwen3.5-plus` (90s timeout), `alibaba/qwen3-coder-plus` (90s), `alibaba/qwen3-coder-next` (60s)
- `qwen-cli/qwen3-coder-plus`, `qwen-cli/qwen3-vl-plus` (vision)

**Kimi / MiniMax / ZAI**:
- `kimi-code/kimi-for-coding`
- `minimax/MiniMax-M2.5-highspeed`
- `zai/glm-5`, `zai/glm-4.5-air`, `zai/glm-4.5-flash`, `zai/glm-4.5`, `zai/glm-4.5v`
- `zai/glm-4.6`, `zai/glm-4.6v`, `zai/glm-4.7`, `zai/glm-4.7-flash`, `zai/glm-4.7-flashx`
- `zai/glm-5v`, `zai/glm-5-flash`

### Router Settings

```yaml
router_settings:
  num_retries: 2
  timeout: 120          # seconds
  retry_after: 1        # seconds between retries
  allowed_fails: 3      # before cooldown
  cooldown_time: 15     # seconds per model after failures
  routing_strategy: simple-shuffle
```

### LiteLLM General Settings

```yaml
litellm_settings:
  drop_params: true         # Remove unsupported params per model
  set_verbose: false
  request_timeout: 120
  cache: true
  cache_params:
    type: local
    ttl: 300               # 5-minute response cache
```

---

## Setting Up LiteLLM

### 1. Install LiteLLM

```bash
pip install litellm[proxy]
```

### 2. Configure `/home/ubuntu/.litellm/config.yaml`

Use the existing config. Required environment variables in `.env`:
- `ANTHROPIC_API_KEY`
- `DASHSCOPE_API_KEY` (Alibaba)
- `MINIMAX_API_KEY`
- `ZAI_API_KEY`
- `LITELLM_MASTER_KEY`

### 3. Start LiteLLM

```bash
litellm --config /home/ubuntu/.litellm/config.yaml --port 4000
```

### 4. Configure gateway `.env`

```env
LITELLM_PROXY_URL=http://localhost:4000
LITELLM_MASTER_KEY=<your-master-key>
```

---

## API Key Gating

All requests to `/v1/chat/completions` require a valid API key issued by the gateway.

### Getting an API Key

1. Log into the dashboard at `https://llm.0xmemo.com/auth`
2. Verify your email via OTP
3. Wait for admin approval (guest → user)
4. Navigate to **API Keys** → **Create New Key**
5. Copy the key — it is shown only once

### Role Requirements

- **guest**: ❌ Cannot create keys or call LLM API
- **user**: ✅ Full LLM access, can manage own keys
- **admin**: ✅ Full access + user management

### Using Your API Key

The gateway accepts keys in two formats:

**Option A — Authorization header (OpenAI-compatible):**
```http
Authorization: Bearer llm_...your_key...
```

**Option B — Custom header:**
```http
x-api-key: llm_...your_key...
```

---

## Example Requests

### cURL

```bash
# Basic chat
curl https://llm.0xmemo.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer llm_...your_key..." \
  -d '{
    "model": "sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Using a specific model
curl https://llm.0xmemo.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-api-key: llm_...your_key..." \
  -d '{
    "model": "zai/glm-5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Streaming
curl https://llm.0xmemo.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer llm_...your_key..." \
  -d '{
    "model": "haiku",
    "stream": true,
    "messages": [{"role": "user", "content": "Tell me a story"}]
  }'
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    api_key="llm_...your_key...",
    base_url="https://llm.0xmemo.com/v1"
)

# Use alias
response = client.chat.completions.create(
    model="sonnet",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# Use specific model
response = client.chat.completions.create(
    model="gemini-cli/gemini-2.5-pro",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

### JavaScript / TypeScript

```typescript
const response = await fetch('https://llm.0xmemo.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer llm_...your_key...',
  },
  body: JSON.stringify({
    model: 'opus',
    messages: [{ role: 'user', content: 'Hello!' }],
  }),
})

const data = await response.json()
console.log(data.choices[0].message.content)
```

### Streaming (JavaScript)

```typescript
const response = await fetch('https://llm.0xmemo.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer llm_...your_key...',
  },
  body: JSON.stringify({
    model: 'haiku',
    stream: true,
    messages: [{ role: 'user', content: 'Count to 10' }],
  }),
})

const reader = response.body!.getReader()
const decoder = new TextDecoder()

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  const chunk = decoder.decode(value)
  // Parse SSE: "data: {...}"
  chunk.split('\n').filter(l => l.startsWith('data: ')).forEach(line => {
    const json = line.slice(6)
    if (json === '[DONE]') return
    const delta = JSON.parse(json).choices[0].delta.content
    if (delta) process.stdout.write(delta)
  })
}
```

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `401 API key required` | Missing header | Add `Authorization: Bearer <key>` or `x-api-key: <key>` |
| `401 Invalid API key` | Key revoked or typo | Regenerate key in dashboard |
| `403 Access denied` | Guest role | Await admin approval |
| `302 redirect to /auth` | No session | Log in via dashboard first |
| `502 Failed to proxy` | LiteLLM not running | Check `systemctl status litellm` or `ps aux | grep litellm` |
| `405 Method Not Allowed` | Caddy not routing `/v1/*` | Check Caddy config includes `handle /v1/* { reverse_proxy localhost:3001 }` |
| Dashboard redirect loop | Session expired | Clear cookies and log in again |
