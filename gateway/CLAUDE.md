Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`

## Single Source of Truth

All model metadata (types, interfaces, provider helpers, formatting, `buildExtendedModel`) lives in `lib/models.ts`. This is the ONE file both server routes and frontend components import from. Never duplicate model logic elsewhere.

Import rules:
- **Server routes** (`routes/*.ts`): `import { ... } from "../lib/models"`
- **Frontend components** (`src/**/*.tsx`): `import { ... } from "@lib/models"` for types/utilities
- **Frontend React hooks/fetch/localStorage**: `import { ... } from "@/lib/models-hooks"` — this is the ONLY file with browser-specific code (React hooks, `fetch()`, `localStorage`)
- **NEVER create re-export wrapper files** (e.g. `src/lib/models.ts` that just does `export * from '../../lib/models'`). Always import directly from the source.

Path aliases (tsconfig.json):
- `@/*` → `./src/*` (frontend components)
- `@lib/*` → `./lib/*` (shared server/client modules)

## Data Fetching — Hooks + react-query

**All frontend data fetching MUST use `@tanstack/react-query` via custom hooks.** Components and pages NEVER contain inline `useQuery`, `useMutation`, `useQueryClient`, or fetch functions.

### Architecture (3 layers)

```
src/lib/query-keys.ts     ← All query key constants (single source of truth)
src/hooks/use*.ts          ← Custom hooks (fetch fns + useQuery/useMutation)
src/components/*.tsx        ← UI only — imports hooks, never touches react-query directly
src/pages/*.tsx
```

### Query Keys — `src/lib/query-keys.ts`

Every `queryKey` MUST be defined in `query-keys.ts` and imported from there. Never use inline string arrays like `['keys']` in hooks or components. This prevents key drift and makes invalidation predictable.

```ts
import { queryKeys } from '@/lib/query-keys'
// queryKeys.keys, queryKeys.auth, queryKeys.adminUsers, etc.
```

### Hook files — `src/hooks/use*.ts`

One hook file per domain. Each file contains:
1. **Types** — interfaces for API responses (exported)
2. **Fetch functions** — standalone `async function fetchX()` (NOT exported — internal to the hook file)
3. **Hooks** — exported `useX()` wrapping `useQuery` / `useMutation`

Existing hooks:
- `useAuth.ts` — `useAuth()`, `useAuthStatus()`, `useLogout()`
- `useKeys.ts` — `useKeys()`, `useCreateKey()`, `useRevokeKey()`
- `useAdmin.ts` — `useAdminUsers()`, `useApproveUser()`, `useRejectUser()`, `useAddUser()`, `useDeleteUser()`, ...
- `useStats.ts` — `useUserStats()`, `useUserStatsAnalytics()`
- `useSettings.ts` — `useModelOverrides()`, `useSaveModelOverrides()`, `useTierAliases()`, `useSaveProfile()`
- `useRequests.ts` — `useGroupedRequests()`, `useGroupItems()`

### Rules

- **Components/pages import hooks only** — `import { useKeys, useCreateKey } from '@/hooks/useKeys'`. No `useQuery`/`useMutation`/`useQueryClient` in component files.
- **Mutations invalidate via queryKeys** — `queryClient.invalidateQueries({ queryKey: queryKeys.keys })` inside the hook's `onSuccess`.
- **No manual loading/error state** — `useQuery` provides `isLoading`, `error`, `data`. Never create parallel `useState` for these.
- **UI state stays in components** — form inputs, dialog open/close, copiedId, etc. remain as local `useState`.
- **`credentials: 'include'`** on all fetch calls.

Example:
```ts
// src/hooks/useKeys.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

async function fetchKeys() { ... }    // NOT exported
async function createKeyApi(name: string) { ... }

export function useKeys() {
  return useQuery({ queryKey: queryKeys.keys, queryFn: fetchKeys })
}

export function useCreateKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: createKeyApi,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.keys }),
  })
}
```

```tsx
// src/components/KeyManager.tsx — NO react-query imports
import { useKeys, useCreateKey } from '@/hooks/useKeys'

export function KeyManager() {
  const { data: keys = [], isLoading } = useKeys()
  const createMutation = useCreateKey()
  // ... render UI
}
```

## Component Props Pattern

Pages and layout components call hooks and pass data down as props. Components NEVER call hooks directly.

### Rules

- **Hook files export their return types** — every exported hook `useX()` has `export type UseXReturn = ReturnType<typeof useX>` in the same file.
- **Components import hook return types** for prop interfaces — never define duplicate types in component files.
- **No hook calls in components** — no `useQuery`, `useMutation`, `useQueryClient`, or any custom hook from `@/hooks/*` or `@/lib/models-hooks` inside `src/components/*.tsx`.
- **Pages and layout call hooks** — `src/pages/*.tsx` and `src/layout/*.tsx` call hooks and pass the full return value (or destructured fields) to components.

### Example

```tsx
// src/hooks/useKeys.ts
export function useKeys() { return useQuery(...) }
export type UseKeysReturn = ReturnType<typeof useKeys>

// src/pages/ApiKeys.tsx
import { useKeys } from '@/hooks/useKeys'
import { KeysList } from '@/components/KeysList'
export function ApiKeys() {
  const keysQuery = useKeys()
  return <KeysList keysQuery={keysQuery} />
}

// src/components/KeysList.tsx — NO hook imports
import type { UseKeysReturn } from '@/hooks/useKeys'
interface Props { keysQuery: UseKeysReturn }
export function KeysList({ keysQuery }: Props) {
  const { data: keys = [], isLoading } = keysQuery
  // render UI
}
```

### Exceptions (document here if any)

- `useModels()` in `ModelSelector.tsx` sub-components: generic reusable dropdown that requires models. These call the hook internally. When the parent has already fetched models, pass via the `models` prop to skip the internal fetch.

## Auth Gates

Three standardized role gates in `lib/db.ts`. All support both API key and session auth:
- `requireAuth` — any authenticated user (including guests)
- `requireUser` — user or admin (not guest)
- `requireAdmin` — admin only

Usage: `const auth = await requireUser(req); if (auth instanceof Response) return auth;`

## Proxy Pattern

The `/v1/*` proxy handler uses `tee()` for fire-and-forget usage tracking — the client gets the response stream immediately, usage is logged in a background IIFE. Never `await` tracking before returning the response.

## Pricing

No hardcoded pricing maps. `calcCost()` in `lib/db.ts` uses a pricing cache populated from LiteLLM's `/model/info` endpoint, refreshed every 5 minutes.
