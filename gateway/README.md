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
litellmctl start gateway

# Manual
bun install
bun run start
```

The gateway loads environment variables from `../.env` via `--env-file` (set in `gateway.py`).

## Auth & Role Gates

Three standardized gates in `lib/db.ts`, all supporting both API key and session auth:

| Gate           | Allows                                | Description                        |
| -------------- | ------------------------------------- | ---------------------------------- |
| `requireAuth`  | Any authenticated user (incl. guests) | Minimum bar — just proves identity |
| `requireUser`  | `user` or `admin` role                | Standard access — excludes guests  |
| `requireAdmin` | `admin` role only                     | Administrative operations          |

Usage pattern in route handlers:

```typescript
async function handler(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  // auth.email and auth.role are available
}
```

## API Routes

All endpoints are callable from the CLI using human-readable commands — no HTTP methods, URLs, or auth needed:

```bash
# List all endpoints (parsed from TypeScript source — works offline)
litellmctl gateway routes

# Call endpoints using path segments as commands
litellmctl gateway api health
litellmctl gateway api stats global
litellmctl gateway api admin users
litellmctl gateway api models extended
litellmctl gateway api search q=hello
litellmctl gateway api admin approve -d '{"email":"user@example.com"}'
```

Tab completion discovers commands from route source files (no gateway needed):

```bash
litellmctl gateway api <TAB>          # health, stats, admin, keys, ...
litellmctl gateway api stats <TAB>    # global, requests, user
litellmctl gateway api admin <TAB>    # users, approve, reject, ...
```

### How it works

- Path segments become CLI arguments: `/api/stats/global` → `stats global`
- HTTP method is auto-inferred: GET by default, POST/PUT/PATCH when `-d` or `key=val` is given
- Action words override the method: `delete` → DELETE, `create` → POST, `update` → PUT
- `key=value` args become query params (GET) or JSON body (POST)
- Routes are parsed from `gateway/routes/*.ts` export blocks — always in sync

### Route groups

| Command prefix | Examples                                                           |
| -------------- | ------------------------------------------------------------------ |
| `health`       | `gateway api health`                                               |
| `stats`        | `gateway api stats global`, `stats user`, `stats requests`         |
| `keys`         | `gateway api keys`, `keys delete <id>`                             |
| `models`       | `gateway api models`, `models extended`                            |
| `user`         | `gateway api user aliases`, `user model-overrides`                 |
| `search`       | `gateway api search q=hello`                                       |
| `admin`        | `gateway api admin users`, `admin approve`, `admin litellm-config` |
| `auth`         | `gateway api auth me`                                              |
| `v1`           | `gateway api v1 models`, `v1 chat completions -d '{...}'`          |

The CLI bypasses all auth gates via a local secret (`.gateway-secret`), generated on each gateway start.

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
