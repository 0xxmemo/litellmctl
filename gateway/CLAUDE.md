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

## Data Fetching — ALWAYS use react-query

**All frontend data fetching MUST use `@tanstack/react-query` (`useQuery` / `useMutation`).** Never use manual `useState` + `useEffect` + `fetch` for server data.

Rules:
- **Reads**: Use `useQuery` with a descriptive `queryKey` array. The QueryClient (in `App.tsx`) handles retry, staleTime, and caching globally.
- **Writes**: Use `useMutation` with `onSuccess` to invalidate related queries via `queryClient.invalidateQueries()`.
- **Fetch functions**: Define standalone `async function fetchX(): Promise<T>` helpers, then pass them as `queryFn`. Keep fetch logic separate from React hooks.
- **No manual loading/error state**: `useQuery` provides `isLoading`, `error`, `data` — never create parallel `useState` for these.
- **Optimistic updates**: For mutations that affect visible lists (e.g. creating/revoking keys), invalidate the query on success so the list refreshes automatically.

Example pattern:
```tsx
// Fetch helper (reusable, testable)
async function fetchKeys(): Promise<APIKey[]> {
  const res = await fetch('/api/keys', { credentials: 'include' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.keys || []
}

// In component
const { data: keys = [], isLoading, error } = useQuery({
  queryKey: ['keys'],
  queryFn: fetchKeys,
})

const createMutation = useMutation({
  mutationFn: (name: string) => fetch('/api/keys', { method: 'POST', ... }).then(r => r.json()),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['keys'] }),
})
```

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
