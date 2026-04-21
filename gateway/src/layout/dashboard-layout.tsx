'use client'
import { useState, useEffect } from 'react'
import { Outlet } from '@tanstack/react-router'
import { Sidebar } from '@/components/sidebar'
import { TopBar } from '@/components/top-bar'
import { Button } from '@/components/ui/button'
import { Menu } from 'lucide-react'
import { Toaster } from 'sonner'
import { useAuth, useLogout } from '@/hooks/useAuth'
import { useAppVersion } from '@/hooks/use-app-version'

export function DashboardLayout() {
  const auth = useAuth()
  const logoutMutation = useLogout()
  const { version } = useAppVersion()
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('dark')

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | 'system' | null
    const initial = savedTheme || 'dark'
    setTheme(initial)
    applyTheme(initial)
  }, [])

  useEffect(() => {
    applyTheme(theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = () => {
      if (theme === 'system') applyTheme('system')
    }
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [theme])

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 768) setMobileSidebarOpen(false)
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return (
    <>
    <div className="flex h-screen overflow-hidden gateway-bg">

      {/* Desktop Sidebar */}
      <div className="hidden md:flex md:flex-shrink-0">
        <div className="glass glass--secondary w-56 shrink-0 border-r-0 shadow-none lg:w-64">
          <div className="flex h-14 items-center border-b border-border/40 px-4">
            <a
              href="/"
              className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity"
              aria-label="LitellmCTL home"
            >
              <img
                src="/public/logo.png"
                alt="LitellmCTL"
                width={28}
                height={28}
                className="flex-shrink-0"
              />
              <div className="flex flex-col min-w-0">
                <span className="text-base lg:text-lg font-bold truncate leading-tight">LitellmCTL</span>
                {version && (
                  <span className="text-[10px] text-muted-foreground font-mono leading-none opacity-70">
                    {version}
                  </span>
                )}
              </div>
            </a>
          </div>
          <div className="p-3 lg:p-4">
            <Sidebar auth={auth} />
          </div>
        </div>
      </div>

      {/* Mobile Sidebar Overlay */}
      {mobileSidebarOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div
            className="glass-overlay fixed inset-0"
            onClick={() => setMobileSidebarOpen(false)}
          />
          <div className="glass glass--secondary relative z-50 flex w-64 max-w-[80vw] flex-col border-r-0 shadow-none">
            <div className="flex h-14 items-center border-b border-border/40 px-4">
              <a
                href="/"
                className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity"
                aria-label="LitellmCTL home"
              >
                <img
                  src="/public/logo.png"
                  alt="LitellmCTL"
                  width={24}
                  height={24}
                  className="shrink-0"
                />
                <div className="flex flex-col min-w-0">
                  <span className="text-base font-bold truncate leading-tight">LitellmCTL</span>
                  {version && (
                    <span className="text-[10px] text-muted-foreground font-mono leading-none opacity-70">
                      {version}
                    </span>
                  )}
                </div>
              </a>
            </div>
            <div className="p-3 flex-1 overflow-y-auto">
              <Sidebar auth={auth} />
            </div>
          </div>
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* Top bar */}
        <div className="glass flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border/40 px-3 shadow-none sm:px-4">
          <div className="flex items-center gap-2 min-w-0">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="md:hidden flex-shrink-0"
              onClick={() => setMobileSidebarOpen(!mobileSidebarOpen)}
              aria-label="Toggle menu"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <a
              href="/"
              className="md:hidden flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity"
              aria-label="LitellmCTL home"
            >
              <img
                src="/public/logo.png"
                alt="LitellmCTL"
                width={24}
                height={24}
                className="shrink-0"
              />
              <span className="text-sm font-bold truncate hidden sm:block">LitellmCTL</span>
            </a>
          </div>
          <TopBar auth={auth} onLogout={() => logoutMutation.mutate()} />
        </div>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          <div className="p-3 sm:p-5 lg:p-6 max-w-7xl mx-auto w-full">
            <Outlet />
          </div>
        </main>

      </div>
    </div>
    <Toaster position="bottom-right" richColors theme={theme === 'system' ? 'system' : theme} />
    </>
  )
}

function applyTheme(theme: 'light' | 'dark' | 'system') {
  const root = document.documentElement
  root.classList.remove('light', 'dark')
  if (theme === 'system') {
    root.classList.add(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  } else {
    root.classList.add(theme)
  }
}
