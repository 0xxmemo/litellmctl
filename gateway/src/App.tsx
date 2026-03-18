/**
 * Simplified App.tsx for Bun-stack LLM Gateway
 *
 * Replaces TanStack Router with simple state-based routing.
 * Keeps all existing components (Sidebar, TopBar, etc.) but removes router dependency.
 */

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
import { UserStats } from './pages/UserStats';
import { AppProvider } from './context/AppContext';

type Page = 'keys' | 'overview' | 'settings' | 'admin' | 'docs' | 'stats';

function DashboardContent({ page }: { page: Page; onPageChange: (p: Page) => void }) {
  switch (page) {
    case 'keys':
      return <ApiKeysPage />;
    case 'overview':
      return <Overview />;
    case 'settings':
      return <Settings />;
    case 'admin':
      return <Admin />;
    case 'docs':
      return <Docs />;
    case 'stats':
      return <UserStats />;
    default:
      return <ApiKeysPage />;
  }
}

export function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState<Page>('keys');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('dark');

  // Check auth status on mount
  useEffect(() => {
    fetch('/api/auth/status', { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        setIsAuthenticated(data.authenticated);
        setUserRole(data.role || null);
      })
      .catch(() => {
        setIsAuthenticated(false);
      });
  }, []);

  // Theme handling
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | 'system' | null;
    setTheme(savedTheme || 'dark');
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      root.classList.add(systemTheme);
    } else {
      root.classList.add(theme);
    }
  }, [theme]);

  // Loading state
  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // Not authenticated - show auth page
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

  // Authenticated - show dashboard
  return (
    <AppProvider>
      <Toaster position="bottom-right" richColors theme={theme === 'system' ? 'system' : theme} />
      <DashboardLayout
        currentPage={currentPage}
        onPageChange={(p: string) => setCurrentPage(p as Page)}
        userRole={userRole}
        theme={theme}
        onThemeChange={setTheme}
      >
        <DashboardContent page={currentPage} onPageChange={setCurrentPage} />
      </DashboardLayout>
    </AppProvider>
  );
}
