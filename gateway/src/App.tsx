'use client';

import { useState, useEffect } from 'react';
import { Toaster } from 'sonner';
import { AuthPage } from './pages/AuthPage';
import { DashboardLayout } from './layout/DashboardLayout';
import { ApiKeys as ApiKeysPage } from './pages/ApiKeys';
import { Overview } from './pages/Overview';
import { Settings } from './pages/Settings';
import { Admin } from './pages/Admin';
import { Docs } from './pages/Docs';
import { AppProvider } from './context/AppContext';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRouter,
  createRoute,
  createRootRoute,
  RouterProvider,
  Outlet,
} from '@tanstack/react-router';

const queryClient = new QueryClient();

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

const docsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/docs',
  component: Docs,
});

const routeTree = rootRoute.addChildren([
  layoutRoute.addChildren([indexRoute, keysRoute, settingsRoute, adminRoute, docsRoute]),
]);

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// ─── App ──────────────────────────────────────────────────────────────────────

export function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('dark');

  useEffect(() => {
    fetch('/api/auth/status', { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        setIsAuthenticated(data.authenticated);
        setUserRole(data.role || null);
      })
      .catch(() => setIsAuthenticated(false));
  }, []);

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

  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <>
        <Toaster position="bottom-right" richColors theme={theme === 'system' ? 'system' : theme} />
        <AuthPage
          onAuthSuccess={(role: string) => {
            setIsAuthenticated(true);
            setUserRole(role);
          }}
        />
      </>
    );
  }

  void userRole; // used for auth check above; role detail comes from AppContext

  return (
    <QueryClientProvider client={queryClient}>
      <AppProvider>
        <RouterProvider router={router} />
      </AppProvider>
    </QueryClientProvider>
  );
}
