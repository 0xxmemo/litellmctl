'use client';

import { useState, useEffect } from 'react';
import { Toaster } from 'sonner';
import { AuthPage } from './pages/AuthPage';
import { DashboardLayout } from './layout/DashboardLayout';
import { ApiKeys as ApiKeysPage } from './pages/ApiKeys';
import { Overview } from './pages/Overview';
import { Settings } from './pages/Settings';
import { Admin } from './pages/Admin';
import { Console } from './pages/Console';
import { Docs } from './pages/Docs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from './hooks/useAuth';
import {
  createRouter,
  createRoute,
  createRootRoute,
  RouterProvider,
  Outlet,
} from '@tanstack/react-router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 2,
    },
  },
});

// ─── Route tree ───────────────────────────────────────────────────────────────

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const layoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'layout',
  component: DashboardLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/',
  component: Overview,
});

const keysRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/keys',
  component: ApiKeysPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/settings',
  component: Settings,
});

const adminRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/admin',
  component: Admin,
});

const consoleRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/console',
  component: Console,
});

const docsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/docs',
  component: Docs,
});

const routeTree = rootRoute.addChildren([
  layoutRoute.addChildren([indexRoute, keysRoute, settingsRoute, adminRoute, consoleRoute, docsRoute]),
]);

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// ─── Inner App (inside QueryClientProvider) ──────────────────────────────────

function AppInner() {
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('dark');
  const { user, loading } = useAuth();

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | 'system' | null;
    setTheme(savedTheme || 'dark');
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    if (theme === 'system') {
      root.classList.add(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    } else {
      root.classList.add(theme);
    }
  }, [theme]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!user || user.role === 'guest') {
    return (
      <>
        <Toaster position="bottom-right" richColors theme={theme === 'system' ? 'system' : theme} />
        <AuthPage />
      </>
    );
  }

  return <RouterProvider router={router} />;
}

// ─── App ──────────────────────────────────────────────────────────────────────

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppInner />
    </QueryClientProvider>
  );
}
