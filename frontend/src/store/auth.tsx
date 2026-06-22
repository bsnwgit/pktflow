import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { api, setToken, clearToken } from '../api/client'

interface AuthState {
  user: { username: string; role: string } | null
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  isLoading: boolean
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthState['user']>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Try silent refresh on mount (restores session after page reload)
  useEffect(() => {
    fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          setToken(data.access_token, data.role)
          return api.getMe()
        }
      })
      .then(me => { if (me) setUser({ username: me.username, role: me.role }) })
      .catch(() => {})
      .finally(() => setIsLoading(false))
  }, [])

  const login = async (username: string, password: string) => {
    const data = await api.login(username, password)
    setToken(data.access_token, data.role)
    const me = await api.getMe()
    setUser({ username: me.username, role: me.role })
  }

  const logout = async () => {
    await api.logout().catch(() => {})
    clearToken()
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, login, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
