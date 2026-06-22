import { ReactNode, useState, useEffect } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../store/auth'
import { api } from '../api/client'
import AiAssistant from './AiAssistant'
import clsx from 'clsx'

const NAV = [
  { to: '/',         label: 'Dashboard',     icon: '⬡' },
  { to: '/devices',  label: 'Devices',       icon: '◈' },
  { to: '/explorer', label: 'Flow Explorer', icon: '⊕' },
  { to: '/topology', label: 'Topology',      icon: '⟳' },
  { to: '/alerts',   label: 'Alerts',        icon: '△' },
  { to: '/settings', label: 'Settings',      icon: '⚙' },
]

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [fps, setFps] = useState<number>(0)
  const [unacked, setUnacked] = useState<number>(0)

  // Live flow rate + unacked alert count — poll every 10 seconds
  useEffect(() => {
    const tick = async () => {
      try {
        const [rateData, events] = await Promise.all([
          api.getFlowRate(),
          api.getAlertEvents(true),
        ])
        setFps(rateData.flows_per_sec)
        setUnacked(events.length)
      } catch {}
    }
    tick()
    const id = setInterval(tick, 10_000)
    return () => clearInterval(id)
  }, [])

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  return (
    <div className="flex h-screen bg-gray-950 text-white overflow-hidden">
      {/* Sidebar */}
      <aside className="w-52 flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col">
        {/* Logo */}
        <div className="flex items-center gap-2 px-4 py-5 border-b border-gray-800">
          <svg className="w-5 h-5 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 12h4l3-9 4 18 3-9h4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span className="font-bold text-white tracking-tight">pktFlow</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-4 space-y-0.5">
          {NAV.map(({ to, label, icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => clsx(
                'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors',
                isActive
                  ? 'bg-blue-600/20 text-blue-300 font-medium'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800',
              )}
            >
              <span className="text-base leading-none">{icon}</span>
              <span>{label}</span>
              {label === 'Alerts' && unacked > 0 && (
                <span className="ml-auto bg-red-500 text-white text-xs font-bold rounded-full px-1.5 py-0.5 leading-none">
                  {unacked}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        {/* User */}
        <div className="px-3 py-3 border-t border-gray-800">
          <div className="flex items-center gap-2 px-2 py-1.5">
            <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold">
              {user?.username?.[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-white truncate">{user?.username}</p>
              <p className="text-xs text-gray-500 capitalize">{user?.role}</p>
            </div>
            <button onClick={handleLogout} title="Sign out" className="text-gray-500 hover:text-gray-300">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header bar */}
        <header className="h-12 flex-shrink-0 bg-gray-900 border-b border-gray-800 flex items-center px-5 gap-4">
          <div className="flex items-center gap-1.5 text-sm">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
            <span className="text-gray-400">Live</span>
            <span className="text-white font-mono font-medium">{fps.toFixed(1)}</span>
            <span className="text-gray-500">flows/sec</span>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto p-5">
          {children}
        </main>
      </div>

      {/* AI assistant — available on all pages */}
      <AiAssistant />
    </div>
  )
}
