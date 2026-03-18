# LLM API Gateway v3.0.0

Thin proxy architecture for LiteLLM proxy with API key validation and session management.

**Live:** https://llm.0xmemo.com

## Architecture

```
User → Gateway (API key validation) → LiteLLM → Model
```

The gateway is a **thin proxy**:
- ✅ API key validation (MongoDB-backed)
- ✅ Session management (hono-sess + MongoStore)
- ✅ Rate limiting
- ✅ Frontend serving (SPA)
- ❌ No duplicate endpoint logic (forwarded to LiteLLM)

LiteLLM handles:
- Model routing
- Format transformation (OpenAI ↔ Anthropic)
- Spend tracking
- Rate limiting
- Fallback chains

## Key Metrics

| Metric | Value |
|--------|-------|
| **Before** | 2,426 lines (index.js) + ~800 lines (Docs.tsx) |
| **After** | 514 lines (index.js) + 340 lines (Docs.tsx) |
| **Reduction** | ~78% line count |
| **Removed** | 11 duplicate endpoints |

## RemovedEndpoints (now LiteLLM proxy)

1. `POST /v1/chat/completions` - Duplicate (now proxy)
2. `POST /v1/messages` - Duplicate (now proxy)
3. `POST /v1/embeddings` - Duplicate (now proxy)
4. `GET /v1/models` - Duplicate (now proxy)
5. `GET /v1/usage` - Duplicate (now proxy)
6. `GET /v1/balance` - Duplicate (now proxy)
7. `POST /v1/images/generations` - Duplicate (now proxy)
8. `GET /v1/keys` - Duplicate (now API key CRUD)
9. `POST /v1/completions` - Duplicate (now proxy)
10. `POST /v1/audio/transcriptions` - Duplicate (now proxy)
11. `POST /v1/audio/transcriptions/base64` - Duplicate (now proxy)

## Preserved Endpoints

### API Key CRUD (Local DB)
- `POST /api/keys` - Create key
- `GET /api/keys` - List keys
- `DELETE /api/keys/:id` - Revoke key
- `PUT /api/keys/:id` - Update key

### Session Auth
- `POST /api/register` - Register/guest-login
- `GET /api/auth/status` - Check auth
- `GET /api/auth/me` - Get current user
- `POST /api/logout` - Logout

### Admin
- `GET /api/admin/pending-requests` - List pending
- `POST /api/admin/validate-email` - Approve user
- `GET /api/admin/users` - List all users

### Dashboard/Settings
- `GET /api/dashboard/stats` - User usage stats
- `GET /api/dashboard/global-stats` - Global usage
- `GET /api/models` - List models
- `POST /api/settings/profile` - Update profile
- `GET /api/analytics/global` - Analytics

### Frontend
- `GET /dashboard` - SPA serve
- `GET /admin` - Admin SPA
- `GET /docs` - API docs SPA
- `GET /assets/*` - Static assets

## Endpoints Thru LiteLLM

All these endpoints forward to `http://localhost:4000`:

| Endpoint | Method | Throughput |
|----------|--------|------------|
| `/v1/chat/completions` | POST | LiteLLM |
| `/v1/messages` | POST | LiteLLM |
| `/v1/embeddings` | POST | LiteLLM |
| `/v1/models` | GET | LiteLLM |
| `/v1/usage` | GET | LiteLLM |
| `/v1/balance` | GET | LiteLLM |
| `/v1/images/generations` | POST | LiteLLM |
| `/v1/completions` | POST | LiteLLM |
| `/v1/audio/transcriptions` | POST | LiteLLM |
| `/v1/audio/transcriptions/base64` | POST | LiteLLM |

Format-agnostic: Use OpenAI or Anthropic format - LiteLLM transforms automatically.

## Authentication

### API Key Header
```bash
Authorization: Bearer YOUR_API_KEY
# or
x-api-key: YOUR_API_KEY
```

### Session Auth
Browser sessions stored in MongoDB with hono-sess.

## Rate Limiting

- Free tier: 100 req/min, 10K req/day
- Pro tier: 1,000 req/min, unlimited

## Quick Start

### 1. Install Dependencies
```bash
bun install
```

### 2. Configure Environment
```bash
cp .env.example .env
```

### 3. Start LiteLLM (port 4000)
```bash
litellm --host 0.0.0.0 --port 4000 --model <model>
```

### 4. Start Gateway
```bash
PORT=3002 bun index.js
```

### 5. Configure Caddy
```caddy
llm.0xmemo.com {
    reverse_proxy localhost:3002
    tls 0xmemo@pm.me
}
```

## Deploy to Production

```bash
# 1. Build frontend
npm run build

# 2. Start gateway (background)
PORT=3002 nohup bun index.js > /tmp/llm-gateway.log 2>&1 &

# 3. Reload Caddy
sudo caddy reload --config /etc/caddy/Caddyfile

# 4. Verify
curl https://llm.0xmemo.com/api/health
```

## Architecture Diagram

```
┌──────────┐      ┌──────────────────────┐      ┌──────────────────┐
│   User   │─────▶│   LLM Gateway        │─────▶│   LiteLLM        │
│          │      │  - API key validation│      │  - Model routing │
│          │      │  - Session management│      │  - Format transform│
│  (CLI,   │      │  - Rate limiting     │      │  - Spend tracking│
│ web, app)│      │  - Frontend serving  │      │  - Fallback chains│
└──────────┘      └──────────────────────┘      └──────────────────┘
           │                                          │
           │                                          ▼
           │                                  ┌──────────────┐
           │                                  │   Model API  │
           │                                  │  (OpenAI/    │
           │                                  │   Anthropic) │
           │                                  └──────────────┘
           │
           ▼
    ┌─────────────┐
    │   MongoDB   │
    │  (Keys +    │
    │   Users)    │
    └─────────────┘
```

## Files Changed

| File | Change |
|------|--------|
| `index.js` | ~78% line reduction, proxy middleware added |
| `src/pages/Docs.tsx` | Updated with architecture diagrams |
| `Caddyfile` | Updated to proxy port 3002 |
| `README.md` | Updated with v3.0.0 architecture |

## Deploying

One command handles everything — kill stale processes, build, deploy static assets, restart the backend:

```bash
bun run deploy
```

This runs `scripts/build-deploy.sh` which:
1. **Kills** any stale process on port 3002
2. **Builds** the frontend (`vite build` + index.html copy)
3. **Deploys** built assets to `/var/www/llm-gateway/`
4. **Restarts** `llm-gateway.service` via systemd
5. **Health checks** `http://localhost:3002/health`

> Use this instead of `build:deploy` — it's more reliable (kills orphan processes, full restart vs reload).

## Testing

```bash
# Health check
curl http://localhost:3002/api/health

# Invalid API key
curl http://localhost:3002/v1/chat/completions \
  -H "x-api-key: invalid"

# Valid API key (proxy test)
curl http://localhost:3002/v1/chat/completions \
  -H "x-api-key: <valid-key-from-db>" \
  -H "Content-Type: application/json" \
  -d '{"model": "sonnet", "messages": [{"role": "user", "content": "test"}]}'
```

## Security Notes

- API keys stored with bcrypt hash
- Sessions expire after 1 year
- Rate limiting at gateway level
- All traffic proxied through LiteLLM (no custom logic)

## Future Improvements

- [ ] Add request/response logging middleware
- [ ] Add metrics endpoint (Prometheus format)
- [ ] Add WebUI for API key management

---

**Version:** 3.0.0 (Thin Proxy)  
**Deployed:** https://llm.0xmemo.com  
**Status:** ✅ Production
