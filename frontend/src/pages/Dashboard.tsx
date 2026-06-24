import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { useAutoRefresh } from '../store/autoRefresh'

export default function Dashboard() {
  const navigate = useNavigate()
  const [fps, setFps] = useState<number | null>(null)

  const load = async () => {
    try {
      const data = await api.getFlowRate()
      setFps(data.flows_per_sec)
    } catch {}
  }

  useEffect(() => { load() }, [])

  const { tick } = useAutoRefresh()
  useEffect(() => { if (tick > 0) load() }, [tick])

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
