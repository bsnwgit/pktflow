import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, getToken } from '../api/client'
import { useAutoRefresh } from '../store/autoRefresh'

export default function Dashboard() {
  const navigate = useNavigate()
  const [fps, setFps] = useState<number | null>(null)
  const [wsConnected, setWsConnected] = useState(false)
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadFps = async () => {
    try {
      const data = await api.getFlowRate()
      setFps(data.flows_per_sec)
    } catch {}
  }

  // Initial REST load
  useEffect(() => { loadFps() }, [])

  // REST fallback — only fires when WS is down
  const { tick } = useAutoRefresh()
  useEffect(() => { if (tick > 0 && !wsConnected) loadFps() }, [tick, wsConnected])

  // WebSocket — live updates from ingest flush events
  useEffect(() => {
    const token = getToken()
    if (!token) return

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${window.location.host}/api/ws/dashboard?token=${encodeURIComponent(token)}`

    let ws: WebSocket
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    const connect = () => {
      if (cancelled) return
      ws = new WebSocket(url)

      ws.onopen = () => {
        setWsConnected(true)
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('ping')
        }, 25000)
      }

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'ingest_stats') loadFps()
        } catch {}
      }

      ws.onclose = () => {
        setWsConnected(false)
        if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null }
        if (!cancelled) reconnectTimer = setTimeout(connect, 5000)
      }

      ws.onerror = () => { ws.close() }
    }

    connect()
    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (pingRef.current) clearInterval(pingRef.current)
      ws?.close()
    }
  }, [])

  return (
    <div className="flex flex-col items-center justify-center h-full text-center gap-6">
      <div>
        <h1 className="text-2xl font-bold text-white mb-1">pktFlow</h1>
        <p className="text-sm text-gray-400">NetFlow visualization platform</p>
      </div>

      {fps !== null && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-8 py-5">
          <p className="text-4xl font-mono font-bold text-blue-300">{fps.toFixed(1)}</p>
          <p className="text-xs text-gray-500 mt-1">flows / sec</p>
          <p className="text-xs mt-2">
            <span className={`inline-block w-2 h-2 rounded-full mr-1 ${wsConnected ? 'bg-green-500' : 'bg-gray-600'}`} />
            <span className="text-gray-500">{wsConnected ? 'live' : 'polling'}</span>
          </p>
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={() => navigate('/analytics')}
          className="bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg px-5 py-2.5 transition-colors"
        >
          Open Analytics
        </button>
        <button
          onClick={() => navigate('/explorer')}
          className="bg-gray-800 hover:bg-gray-700 text-white text-sm rounded-lg px-5 py-2.5 border border-gray-700 transition-colors"
        >
          Flow Explorer
        </button>
        <button
          onClick={() => navigate('/settings?tab=devices')}
          className="bg-gray-800 hover:bg-gray-700 text-white text-sm rounded-lg px-5 py-2.5 border border-gray-700 transition-colors"
        >
          Manage Devices
        </button>
      </div>
    </div>
  )
}
