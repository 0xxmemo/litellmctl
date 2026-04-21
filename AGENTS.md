# Project rules

### Naming Conventions

| Type                           | Convention         | Example                          |
| ------------------------------ | ------------------ | -------------------------------- |
| **Files & Folders**            | kebab-case         | `user-profile.ts`, `use-auth.ts` |
| **Functions & Variables**      | camelCase          | `getUserData`, `userName`        |
| **Components, Classes, Types** | PascalCase         | `UserProfile`, `ApiResponse`     |
| **Database Elements**          | snake_case         | `user_profiles`, `created_at`    |
| **Generic Types**              | T prefix           | `TUserData`, `TApiResponse`      |
| **Type Parameters**            | `<type>Params`     | `GetUserParams`                  |
| **Return Types**               | `<type>ReturnType` | `GetUserReturnType`              |

**Product name in code:** Do not prefix components, hooks, types, or modules with the product name (`Booster*`). The repo is already the product. Reserve “Booster” for user-facing copy, branding assets/DNS, and **immutable wire strings** (e.g. cookie / `localStorage` keys already deployed) when renaming would break clients. TypeScript identifiers for those constants can be neutral (`APP_LOCALE_COOKIE`, etc.) while the string value stays historical if needed.

### TypeScript Guidelines

- **Always** be type-safe - no `any` types
- **Never** duplicate type definitions, constants, default values, or configuration objects. If a value is already exported from a module (e.g. `defaultConfig` in a provider), import it — do not copy the same literal into another file.
- **Avoid** default exports unless necessary
- **Use** explicit return types for functions

### Import and Export Rules

- **Always** use `export *` patterns from package or folder `index` files
- **Never** mix type and runtime imports on the same line, even when importing from the same file
- **Never** mix type and runtime exports on the same line, even when exporting from the same file
- **Keep** type-only imports and exports on their own dedicated lines

Example:

```ts
import { userSchema } from "./user-schema";
import type { User } from "./user-schema";

export { userSchema } from "./user-schema";
export type { User } from "./user-schema";
```

### React Best Practices

- **Use** functional components with hooks
- **Use** custom hooks for reusable logic (`hooks/`). Keep **pages and layouts thin**: orchestration, validation, and mutations for a screen should live in `gateway/hooks/` (e.g. `use-*.ts`), not inline.
- **Follow** React hooks rules (proper dependencies, avoid infinite loops)
- **Keep** components small and focused (single responsibility)

### Testing Style

Tests follow a strict **red → green** discipline:

1. **Write the test first, expect it to fail.** A new test case must be red before any source changes are made. This confirms the test actually exercises the code path.
2. **Fix the source, not the test.** When a test is red, iterate on the source code until the test goes green. Do not modify the test to force it to pass.
3. **Only touch a test when the test case itself is wrong.** A test may be updated only if the assertion or setup is genuinely incorrect — e.g. it tests the wrong behaviour, or would suppress a real green signal by asserting too loosely. Never weaken or delete a test just because the source is broken.
4. **Once green, leave it alone.** A passing test is a contract. Do not refactor, relax, or remove it unless the intended behaviour has explicitly changed.
5. **A future red signals a source regression.** If a previously green test turns red, the source broke — not the test. Treat it as a regression and fix the source.

<!-- BEGIN:bun-agent-rules -->

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#e2e.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

<!-- END:bun-agent-rules -->
