# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0] - 2026-03-10

### 🔧 Request Grouping Fix
- Fixed flaky bucket grouping causing skipped or merged requests
- Consecutive same-provider/model/endpoint requests now correctly grouped

### 📊 Global Metrics Fix
- Global stats now uses LiteLLM PostgreSQL exclusively
- Removed MongoDB merge that caused data duplication and inaccurate totals
- Model usage reflects true LiteLLM spend data only

### 👥 Admin Users Usage Fix
- Fixed admin users page showing 0 usage for all users
- Per-user stats now correctly pulled from MongoDB usage_logs

### 🖼️ Logo Loading Fix
- Fixed root-level static files (icons, manifest) not served correctly
- Caddy now serves icons and manifest.json via file_server at root

### ⚙️ Model Overrides Gate Fix
- Model Overrides settings previously restricted to admin only
- Now accessible to all non-guest users (all authenticated team members)

### 🛠️ Model Overrides Endpoint Fix
- Model Overrides config separated from admin config endpoint
- Dedicated endpoint prevents interference with admin-only settings

### 🔍 Model Overrides Filter
- Model Overrides list now shows only stub aliases (opus, sonnet, haiku)
- Previously showed all 76 model aliases — now filtered to tier stubs only

### 🤖 Claude Code Setup Script
- New `/setup/claude-code.sh` endpoint served directly from gateway
- One-liner install with env var injection:
  ```bash
  LLM_GATEWAY_API_KEY="sk-..." curl http://your-gateway/setup/claude-code.sh | bash
  ```
- Automatically configures Claude Code to use the gateway

## [1.5.2] - 2026-03-09

### 📬 Stacked Recent Requests
- Group consecutive same-provider/model/endpoint requests
- Show "Nx" badge for stack count
- Click to expand, see individual items
- On-demand load for nested items
- Top-level pagination with "Load More"

### 📊 Compact Model Usage Table
- Reduced row height, padding, font size
- Color dot for provider scanning
- Scrollable with fixed max-height
- Sticky header while scrolling
- Responsive columns (mobile-friendly)

### 🚀 Deploy Script
- Resolved multiple white page occurrences
- One-command deploy handles everything

## [1.5.1] - 2026-03-09

### 📊 Global Metrics - All Models Visible
- Fixed missing models (codex, glm, kimi, minimax, etc.)
- Switched to LiteLLM_DailyUserSpend table
- Shows ALL models with requests (including $0 spend)
- 20 models → 75 models visible

### 📱 Responsive Pie Chart Legend
- Custom 2-column grid legend (replaced Recharts)
- Strips provider prefixes
- Mobile: Top 5 items + expandable "+N more"
- Desktop: All items in compact grid
- Reduced pie height (380px → 300px)

### 🚀 Reusable Deploy Script
- New scripts/build-deploy.sh
- Usage: bun run deploy
- Handles: kill, build, deploy, restart, health check
- Prevents blank page issues

## [1.5.0] - 2026-03-09

### 📊 Global Stats - Complete Rewrite
- Fixed critical pagination bug (pageSize=500, max is 100)
- Direct PostgreSQL aggregate query (O(1) vs 47 HTTP requests)
- Shows real model names (alibaba/qwen3.5-plus) not aliases (opus)
- 100% data consistency with LiteLLM DB
- Removed alias mapping code (no fake data)

### ⚙️ ConfigEditor Fixes
- Fixed tier input focus loss (local state + onBlur)
- Fixed last item select z-index (portal rendering)
- Fixed save validation error (strip model_info)
- Fixed refetch after save (immediate UI update)
- Simplified endpoints to pure LiteLLM proxies

### 🔐 Admin Features
- Cascade delete: user deletion deletes API keys
- Revoke All Keys: one-click revoke with confirmation
- Shows count of revoked keys

### 🧹 Cleanup
- Killed LiteLLM port 4000 (consolidated to 4040)
- Removed dead files (1,389 lines)
- Single LITELLM_URL env var

### 📚 Docs
- Fixed duplicate models (308 → 44 unique)

### 🔧 Reset Endpoint
- Pure proxy to LiteLLM POST /config/reset

## [1.4.0] - 2026-03-09

### 🎨 ConfigEditor Improvements
- Drag-and-drop reordering within fallback chains
- Drag fallback to top → becomes Primary (updates model_group_alias)
- Drag Primary down → becomes fallback
- "Reset to Defaults" button with confirmation dialog
- Auto-refetch config after reset

### 📊 Usage Chart Fix
- Chart now shows real per-day data from MongoDB (last 30 days)
- Fixed fake data issue (was showing zeros)
- MongoDB aggregation groups usage_logs by date
- Fixed dailyRequests not being passed to frontend

### 🔧 Config Endpoints
- Verified all config endpoints work correctly
- Added POST /config/reset endpoint
- All endpoints return 401 without auth (correct behavior)

### 🐛 Bug Fixes
- Fixed "Reset failed: Not Found" error
- Fixed save error display (was showing [object Object])

## [1.3.0] - 2026-03-06

### 🚨 Critical Fixes
- Fixed model alias resolution to include model_group_alias from LiteLLM config
- Usage logs now show resolved models (e.g., "codex/gpt-5.3-codex" not "opus")
- Model overrides work for ALL aliases, not just ['opus','sonnet','haiku']

### 📊 Usage Tracking
- SSE streaming responses now tracked (was missing entirely)
- Audio transcription endpoints track usage correctly
- Real-time tracking with periodic queue flush

### ✨ New Features
- Recent Requests table in Overview page (My Usage tab)
- Auto-refresh every 10s for live updates
- Shows model, endpoint, tokens, cost, timestamp

### 🔄 TanStack React Query Migration
- Eliminated refresh flash on data fetches
- Unified caching across all components
- Background refetch with silent updates
- Proper cache invalidation on mutations

### 🐛 Bug Fixes
- Fixed ROUTER_FIELDS is not defined error in ConfigEditor
- Fixed model selector duplicate API calls (now 1 call total)
- Fixed audio transcription usage tracking

### 🧹 Code Quality
- Removed duplicate PROVIDER_AUTH_MAP
- Removed duplicate resolveProvider functions
- Removed Shepherd references (simplified ACP enforcement)

## [1.2.1] - 2026-03-06

### Added

- **AppContext / React Context Provider** — New `src/context/AppContext.tsx` centralizes all data fetching for the dashboard. `AppProvider` wraps the router in `dashboard-main.tsx` and exposes a single `useAppContext()` hook for models, config, globalStats, userStats, and auth state.
- **Centralized Model Fetching** — All model selector components (`ConfigModelSelector`, `TierModelSelector`, `ModelSelector`) now consume models from `AppContext` via `useContextOrLocalModels()`, ensuring a single `/v1/models` fetch is shared across the entire app instead of one per component.
- **Centralized Stats Fetching** — `Overview.tsx` now uses `useAppContext()` for globalStats, userStats, auth, and rate-limit state; no more independent fetch logic per page.
- **Auto-Polling in Context** — The 60-second stats poll runs in `AppProvider`, not each page individually. Only polls stats that have been loaded (lazy-tab pattern preserved).
- **refreshAfterSave()** — After saving config in `ConfigEditor`, a centralized `refreshAfterSave()` refreshes models + config in the shared context so all components see fresh data.
- **Rate-Limit Backoff** — Global rate-limit state (`rateLimited`, 5-minute backoff on 429) lives in `AppContext` and is shared across all components.

### Fixed

- **`resolveActualModel` duplicate declaration** — Removed conflicting `import { resolveActualModel }` from `index.js`; the local `function resolveActualModel` (which uses the `ALIAS_TO_MODEL` map) is authoritative.

### Changed

- **Overview.tsx** — Fully refactored to use `useAppContext()` instead of independent `fetch` calls, auth checks, and rate-limit timers.
- **ModelSelector.tsx** — Updated `ConfigModelSelector`, `TierModelSelector`, and `ModelSelector` to prefer context models when inside `<AppProvider>`, falling back to direct `useModels()` when used standalone (e.g. in Docs).
- **ConfigEditor.tsx** — Uses `useAppContext()` for model list in `FallbacksEditor`; calls `refreshAfterSave()` after save.

### Performance

- **Eliminated N redundant API calls** — Opening ConfigEditor (Fallbacks tab) with many chains no longer triggers N separate `/v1/models` fetches; all selectors share the same in-memory list from context.
- **Single auth check** — Auth (`/api/auth/me`) checked once in `AppProvider` on mount; all pages read from context.

## [1.0.0] - 2026-03-05

### Added

- **Session/Cookie Persistence** — Session cookies now persist for 1 year; users stay logged in across browser restarts and server reboots.
- **API Key Management** — Full create/revoke API key workflow via the dashboard UI and `POST /api/keys` / `DELETE /api/keys/:id` endpoints.
- **API Key Auth Validation** — Bearer token auth now validates keys via SHA-256 hash lookup + bcrypt comparison, enabling secure programmatic access.
- **Dashboard Stats (Real Data)** — Global stats endpoint aggregates real usage data from LiteLLM `/global/activity`, surfacing total requests, total tokens, model breakdown, and top users.
- **Model Aliases** — Configured shorthand aliases: `opus` (Claude Opus), `local/whisper` (local Whisper ASR), `local/nomic-embed-text` (local embeddings).
- **Audio Transcriptions Fix** — `/v1/audio/transcriptions` now accepts both multipart form-data and JSON with base64-encoded audio, resolving 422 errors from the Try tab.
- **Images Endpoint** — `/v1/images/generations` proxied through LiteLLM using the `opus` alias; Try tab shows image preview inline.
- **PrettyDate + PrettyAmount Components** — Reusable React components for human-readable date and number formatting across the dashboard.
- **Public Docs Route** — `/docs` is accessible without authentication so potential users can explore the API before signing up.
- **Try It Tabs** — Inline Try panels per endpoint on the Docs page with live API key input, curl snippets, and real request/response display.
- **Sonner Toasts** — Migrated all toast notifications to [Sonner](https://sonner.emilkowal.ski/); positioned bottom-right.
- **Public `/v1/models` Endpoint** — `GET /v1/models` is unauthenticated so clients can enumerate available models without a key.
- **OTP Resend Cooldown** — 60-second frontend cooldown on OTP resend to prevent rapid re-requests.
- **E2E Session Persistence Test** — 18-assertion Playwright test suite validating cookie-based session persistence.

### Changed

- **Caddy Migration** — Replaced Nginx + Certbot with Caddy for automatic HTTPS and simpler reverse-proxy configuration.
- **Docs Overhaul** — Merged OpenAI and Anthropic sections into a single unified "API Endpoints" section; added local model presets for transcription (`local/whisper`) and embeddings (`local/nomic-embed-text`); replaced static model list with live LiteLLM fetch.
- **Auth Flow** — Fixed `/api/auth/me` response shape mismatch that caused an infinite auth redirect loop.
- **Admin Panel** — Fixed approve/reject/delete/disapprove-all backend endpoints; disapprove-all now correctly targets pending (guest) users; button counts reflect approvable user count.
- **Global Stats** — Model name normalization eliminates duplicates in the model usage breakdown; `totalRequests` and `totalTokens` sourced from LiteLLM `/global/activity`.
- **Model Breakdown** — Mobile-responsive layout fixes for the Model Breakdown table on small screens.

### Removed

- **Nginx** — Removed in favour of Caddy.
- **Notifications UI** — Removed notification bell and notification panel from the dashboard.
- **Static Docs Model List** — Replaced with live LiteLLM model fetch.
- **Pricing Tiers** — Removed static pricing tier display from Docs page.

### Fixed

- `POST /api/keys` — Missing `bcrypt`/`ObjectId` imports and incorrect key storage field name.
- `fix: disapprove-all` — Was incorrectly targeting approved users instead of guests.
- `GET /v1/models` — `createProxyMiddleware` auth check was blocking the public endpoint even after marking it public in the route config.
- `/v1/audio/transcriptions` — 422 error from the Try tab caused by strict multipart-only parsing; now accepts JSON + base64.
- Sonner toast position — Moved from top-right to bottom-right.

[1.0.0]: https://github.com/0xmemo-claw/llm-api-gateway/releases/tag/v1.0.0
