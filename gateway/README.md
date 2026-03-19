# LLM API Gateway

Authentication and rate-limiting proxy for LiteLLM, built with Bun.serve().

## Architecture

```
Client (CLI / Web / App)
    │
    ▼
┌─────────────────────────┐
│   LLM API Gateway       │  :14041
│   (Bun.serve)           │
│                         │
│  ├─ OTP auth (email)    │
│  ├─ API key validation  │──── MongoDB
│  ├─ Role-based access   │    (keys, users,
│  ├─ Usage tracking      │     sessions, logs)
│  └─ Frontend (React SPA)│
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│   LiteLLM Proxy         │  :4040
│                         │
│  ├─ Model routing       │
│  ├─ Format transform    │
│  ├─ Spend tracking      │
│  └─ Fallback chains     │
└────────────┬────────────┘
             │
             ▼
      Model APIs
  (Anthropic, OpenAI,
   Gemini, Qwen, etc.)
```

## Quick Start

```bash
# Via litellmctl (recommended)
litellmctl gateway start

# Manual
bun install
bun run start
```

The gateway loads environment variables from `../.env` via `--env-file` (set in `gateway.py`).

## Auth & Role Gates

Three standardized gates in `lib/db.ts`, all supporting both API key and session auth:

| Gate | Allows | Description |
|------|--------|-------------|
| `requireAuth` | Any authenticated user (incl. guests) | Minimum bar — just proves identity |
| `requireUser` | `user` or `admin` role | Standard access — excludes guests |
| `requireAdmin` | `admin` role only | Administrative operations |

Usage pattern in route handlers:

```typescript
async function handler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  // auth.email and auth.role are available
}
```

## API Routes

### Public (no auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/models` | List available models |
| GET | `/api/health` | Health check |

### requireAuth (any authenticated user)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/model/info` | Model metadata (proxy to LiteLLM) |
| GET | `/api/dashboard/global-stats` | Global usage statistics |
| GET | `/api/overview/requests/grouped` | Grouped request history |

### requireUser (user or admin)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/keys` | List user's API keys |
| POST | `/api/keys` | Create API key |
| DELETE | `/api/keys/:id` | Revoke API key |
| PUT | `/api/keys/:id` | Update key name/alias |
| GET | `/api/models` | Model list (from LiteLLM /model/info) |
| GET | `/api/models/extended` | Extended model metadata with capabilities |
| GET | `/api/config/aliases` | Model group aliases from config |
| GET | `/api/dashboard/user-stats` | Per-user usage stats |
| PUT | `/api/user/profile` | Update name/company |
| GET/PUT | `/api/user/model-overrides` | Per-user model overrides |
| POST | `/v1/chat/completions` | Chat proxy to LiteLLM |
| POST | `/v1/completions` | Completions proxy |
| POST | `/v1/embeddings` | Embeddings proxy |
| POST | `/v1/audio/transcriptions` | Transcription proxy |

### requireAdmin

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/pending` | Pending access requests |
| POST | `/api/admin/approve` | Approve user |
| GET | `/api/admin/users` | List all users |
| POST | `/api/admin/users` | Create/update user |
| DELETE | `/api/admin/users/*` | Delete user |
| POST | `/api/admin/reject` | Reject user (set to guest) |
| POST | `/api/admin/disapprove-all` | Remove all guests |
| POST | `/api/admin/keys/revoke-all` | Revoke all API keys |
| GET/PATCH | `/api/admin/litellm-config` | Read/update config.yaml |
| POST | `/api/admin/litellm-config/reset` | Re-read config from disk |

### Auth (no auth required)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/request-otp` | Send OTP code via email |
| POST | `/api/auth/verify-otp` | Verify OTP and create session |
| GET | `/api/auth/status` | Check session status |
| GET | `/api/auth/me` | Get current user info |
| GET/POST | `/api/auth/logout` | Clear session |

## Authentication

### API Key
```bash
curl -H "Authorization: Bearer sk-llm-..." http://localhost:14041/v1/chat/completions
# or
curl -H "x-api-key: sk-llm-..." http://localhost:14041/v1/chat/completions
```

### Session (browser)
OTP-based email login. Sessions stored in MongoDB, delivered via `sessionId` httpOnly cookie.

## Development

```bash
bun run dev          # Hot-reload server
bun run build        # Build frontend (React + Tailwind)
bun run type-check   # TypeScript checking
bun test             # Run tests
```

## Project Structure

```
gateway/
├── index.ts              # Bun.serve() entry, routes, static files
├── frontend.tsx          # React SPA entry point
├── lib/
│   ├── config.ts         # Runtime config (LiteLLM URL, master key, port)
│   ├── db.ts             # MongoDB connection, auth gates, usage tracking
│   ├── auth.ts           # JWT sessions, API key extraction
│   ├── email-service.ts  # ProtonMail SMTP (hydroxide) for OTP
│   └── otp.ts            # OTP generation/validation
├── routes/
│   ├── auth.ts           # OTP login/logout
│   ├── keys.ts           # API key CRUD
│   ├── models.ts         # Model listing (public + extended)
│   ├── stats.ts          # Dashboard statistics
│   ├── user.ts           # Profile, model overrides, aliases
│   ├── admin.ts          # User/key management, config
│   └── proxy.ts          # LiteLLM proxy with usage tracking
├── src/
│   ├── components/       # React UI components
│   ├── pages/            # SPA pages (Docs, ApiKeys, Settings, Admin)
│   └── lib/              # Frontend models, services
└── bunfig.toml           # Bun configuration
```

## Security

- API keys stored as SHA-256 hashes (plaintext never persisted)
- OTP codes expire after 5 minutes
- Sessions are httpOnly, SameSite=Strict cookies
- Role-based access enforced on every route via standardized gates
- Proxy strips client auth headers before forwarding to LiteLLM
