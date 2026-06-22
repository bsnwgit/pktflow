import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, DeviceSummary } from '../api/client'
import { AreaChart, Area, Tooltip, ResponsiveContainer } from 'recharts'

function formatBytes(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB'
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB'
  return b + ' B'
}

function formatFlows(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K'
  return String(n)
}

const SEVERITY_DOT: Record<string, string> = {
  online:  'bg-green-400',
  stale:   'bg-yellow-400',
  offline: 'bg-red-400',
}

function statusFromLastSeen(lastSeen: string | null): 'online' | 'stale' | 'offline' {
  if (!lastSeen) return 'offline'
  const ago = (Date.now() - new Date(lastSeen).getTime()) / 1000
  if (ago < 120) return 'online'
  if (ago < 600) return 'stale'
  return 'offline'
}

interface DeviceCardProps {
  device: DeviceSummary
  onClick: () => void
}

function DeviceCard({ device, onClick }: DeviceCardProps) {
  const status = statusFromLastSeen(device.last_seen)
  const dotClass = SEVERITY_DOT[status]

  return (
    <button
      onClick={onClick}
      className="bg-gray-900 border border-gray-800 rounded-xl p-5 text-left hover:border-blue-600/50 hover:bg-gray-800/50 transition-all group"
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClass}`}></span>
            <h3 className="font-semibold text-white group-hover:text-blue-300 transition-colors">
              {device.sampler_name || device.sampler_ip}
            </h3>
          </div>
          <p className="text-xs text-gray-500 ml-4">{device.site} · {device.sampler_ip}</p>
        </div>
        <span className="text-xs text-gray-600 font-mono">
          {device.flows_per_sec.toFixed(1)}/s
        </span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Bytes/hr</p>
          <p className="text-sm font-medium text-white">{formatBytes(device.bytes_last_hour)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Flows/hr</p>
          <p className="text-sm font-medium text-white">{formatFlows(device.flows_last_hour)}</p>
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-0.5">Status</p>
          <p className={`text-sm font-medium capitalize ${
            status === 'online' ? 'text-green-400' :
            status === 'stale' ? 'text-yellow-400' : 'text-red-400'
          }`}>{status}</p>
        </div>
      </div>
    </button>
  )
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [devices, setDevices] = useState<DeviceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    try {
      const data = await api.getDeviceSummaries()
      setDevices(data)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Dashboard</h1>
          <p className="text-sm text-gray-400 mt-0.5">All NetFlow collectors</p>
        </div>
        <button
          onClick={load}
          className="text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-lg px-3 py-1.5 transition-colors"
        >
          Refresh
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center h-48 text-gray-500">
          Loading…
        </div>
      )}

      {error && (
        <div className="bg-red-950 border border-red-800 rounded-xl p-4 text-red-300 text-sm mb-4">
          {error}
        </div>
      )}

      {!loading && devices.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center h-48 text-gray-500">
          <p className="text-lg mb-2">No flow data yet</p>
          <p className="text-sm">Configure your collectors to send data to pktFlow.</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {devices.map(d => (
          <DeviceCard
            key={d.sampler_ip}
            device={d}
            onClick={() => navigate(`/devices/${encodeURIComponent(d.sampler_ip)}`)}
          />
        ))}
      </div>
    </div>
  )
}
