import { useState, useEffect } from 'react'

export interface User {
  email: string
  role: 'admin' | 'user' | 'guest'
  name?: string
  company?: string
}

interface UseAuthReturn {
  user: User | undefined
  loading: boolean
  refreshUser: () => Promise<void>
}

export function useAuth(): UseAuthReturn {
  const [user, setUser] = useState<User | undefined>()
  const [loading, setLoading] = useState(true)

  const loadUser = async () => {
    try {
      // Fetch auth status from /api/auth/me (returns { authenticated, user: { email, role } })
      const res = await fetch('/api/auth/me', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        if (data.authenticated && data.user) {
          setUser({ 
            email: data.user.email, 
            role: data.user.role as 'admin' | 'user' | 'guest'
          })
        } else {
          setUser(undefined)
        }
      } else {
        setUser(undefined)
      }
    } catch (error) {
      console.error('Error loading user:', error)
      setUser(undefined)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadUser()
  }, [])

  return {
    user,
    loading,
    refreshUser: loadUser
  }
}
