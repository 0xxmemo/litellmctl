'use client'
import { useState, useEffect } from 'react'
import { Outlet } from '@tanstack/react-router'
import { Sidebar } from '@/components/Sidebar'
import { TopBar } from '@/components/TopBar'
import { Toaster } from 'sonner'
import { useAuth, useLogout } from '@/hooks/useAuth'

export function DashboardLayout() {
  const auth = useAuth()
  const logoutMutation = useLogout()
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
    <div className="flex h-screen overflow-hidden bg-background">

      {/* Desktop Sidebar */}
      <div className="hidden md:flex md:flex-shrink-0">
        <div className="w-56 lg:w-64 border-r bg-card">
          <div className="flex h-14 items-center border-b px-4">
            <a
              href="/"
              className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity"
              aria-label="LLM API Gateway home"
            >
              <img
                src="/icon-32.png"
                alt="LLM API Gateway"
                width={28}
                height={28}
                className="flex-shrink-0"
              />
              <span className="text-base lg:text-lg font-bold truncate">LLM Gateway</span>
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
            className="fixed inset-0 bg-black/60"
            onClick={() => setMobileSidebarOpen(false)}
          />
          <div className="relative z-50 w-64 max-w-[80vw] bg-card border-r flex flex-col">
            <div className="flex h-14 items-center border-b px-4">
              <a
                href="/"
                className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity"
                aria-label="LLM API Gateway home"
              >
                <img
                  src="/icon-32.png"
                  alt="LLM API Gateway"
                  width={24}
                  height={24}
                  className="flex-shrink-0"
                />
                <span className="text-base font-bold truncate">LLM Gateway</span>
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
        <div className="border-b bg-card h-14 flex-shrink-0 flex items-center justify-between px-3 sm:px-4 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button
              className="md:hidden p-2 rounded-md hover:bg-accent transition-colors flex-shrink-0"
              onClick={() => setMobileSidebarOpen(!mobileSidebarOpen)}
              aria-label="Toggle menu"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <a
              href="/"
              className="md:hidden flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity"
              aria-label="LLM API Gateway home"
            >
              <img
                src="/icon-32.png"
                alt="LLM API Gateway"
                width={24}
                height={24}
                className="flex-shrink-0"
              />
              <span className="text-sm font-bold truncate hidden sm:block">LLM API Gateway</span>
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
