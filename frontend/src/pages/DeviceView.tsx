import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts'
import { api, DeviceSummary, TimeSeriesPoint, TopTalker } from '../api/client'

// ── Helpers ───────────────────────────────────────────────────────────────────

const WINDOWS = ['1h', '6h', '24h', '7d', '30d'] as const
type Window = typeof WINDOWS[number]

const PROTO_NAMES: Record<number, string> = {
  1: 'ICMP', 6: 'TCP', 17: 'UDP', 41: 'IPv6', 47: 'GRE',
  50: 'ESP', 51: 'AH', 58: 'ICMPv6', 89: 'OSPF', 132: 'SCTP',
}

function protoLabel(n: number) { return PROTO_NAMES[n] ?? `IP/${n}` }

function fmtBytes(b: number): string {
  if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB'
  if (b >= 1e9)  return (b / 1e9).toFixed(2) + ' GB'
  if (b >= 1e6)  return (b / 1e6).toFixed(1) + ' MB'
  if (b >= 1e3)  return (b / 1e3).toFixed(1) + ' KB'
  return b + ' B'
}

function fmtBps(bytes: number, windowSec: number): string {
  const bps = (bytes * 8) / windowSec
  if (bps >= 1e9)  return (bps / 1e9).toFixed(2) + ' Gbps'
  if (bps >= 1e6)  return (bps / 1e6).toFixed(1) + ' Mbps'
  if (bps >= 1e3)  return (bps / 1e3).toFixed(1) + ' Kbps'
  return bps.toFixed(0) + ' bps'
}

const WINDOW_SECS: Record<Window, number> = {
  '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000,
}

function fmtTs(ts: string, window: Window): string {
  const d = new Date(ts)
  if (window === '30d' || window === '7d')
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function buildProtoDist(talkers: TopTalker[]) {
  const map: Record<string, number> = {}
  for (const t of talkers) {
    const label = protoLabel(t.protocol)
    map[label] = (map[label] ?? 0) + t.bytes
  }
  return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([name, bytes]) => ({ name, bytes }))
}

function TimeTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-gray-400 mb-2">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-gray-300">{p.name}:</span>
          <span className="text-white font-medium">
            {p.dataKey === 'bytes' ? fmtBytes(p.value) : p.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Top Talkers Table ─────────────────────────────────────────────────────────
function TopTalkersTable({ talkers, totalBytes, onDrillDown }: {
  talkers: TopTalker[]
  totalBytes: number
  onDrillDown: (src: string, dst: string) => void
}) {
  const [sortBy, setSortBy] = useState<'bytes' | 'packets' | 'flow_count'>('bytes')
  const sorted = [...talkers].sort((a, b) => b[sortBy] - a[sortBy])

  const Col = ({ col, label }: { col: typeof sortBy; label: string }) => (
    <th
      className={`px-4 py-3 text-left text-xs font-medium cursor-pointer select-none transition-colors
        ${sortBy === col ? 'text-blue-400' : 'text-gray-400 hover:text-gray-200'}`}
      onClick={() => setSortBy(col)}
    >
      {label} {sortBy === col && '↓'}
    </th>
  )

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Source IP</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Destination IP</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Port</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Proto</th>
            <Col col="bytes" label="Bytes" />
            <Col col="packets" label="Packets" />
            <Col col="flow_count" label="Flows" />
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-400">Share</th>
            <th className="px-4 py-3 text-xs font-medium text-gray-400" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/50">
          {sorted.map((t, i) => {
            const pct = totalBytes > 0 ? ((t.bytes / totalBytes) * 100).toFixed(1) : '0'
            return (
              <tr key={i} className="hover:bg-gray-800/40 transition-colors group">
                <td className="px-4 py-2.5 font-mono text-blue-300 text-xs">{t.src_ip}</td>
                <td className="px-4 py-2.5 font-mono text-purple-300 text-xs">{t.dst_ip}</td>
                <td className="px-4 py-2.5 text-gray-300">{t.dst_port}</td>
                <td className="px-4 py-2.5">
                  <span className="bg-gray-800 text-gray-300 text-xs px-2 py-0.5 rounded">
                    {protoLabel(t.protocol)}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-white font-medium">{fmtBytes(t.bytes)}</td>
                <td className="px-4 py-2.5 text-gray-300">{t.packets.toLocaleString()}</td>
                <td className="px-4 py-2.5 text-gray-400">{t.flow_count.toLocaleString()}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="w-14 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.min(100, parseFloat(pct))}%` }} />
                    </div>
                    <span className="text-gray-400 text-xs">{pct}%</span>
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <button
                    onClick={() => onDrillDown(t.src_ip, t.dst_ip)}
                    className="text-xs text-blue-400 hover:text-blue-300 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Drill into flows between these IPs"
                  >
                    Drill in →
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {sorted.length === 0 && (
        <div className="text-center py-12 text-gray-500">No flow data for this window</div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DeviceView() {
  const { ip } = useParams<{ ip?: string }>()
  const navigate = useNavigate()

  const [devices, setDevices]   = useState<DeviceSummary[]>([])
  const [selected, setSelected] = useState<string>(ip ?? '')
  const [window, setWindow]     = useState<Window>('1h')
  const [series, setSeries]     = useState<TimeSeriesPoint[]>([])
  const [talkers, setTalkers]   = useState<TopTalker[]>([])
  const [loading, setLoading]   = useState(false)
  const [activeTab, setActiveTab] = useState<'chart' | 'talkers' | 'proto'>('chart')

  useEffect(() => {
    api.getDeviceSummaries().then(d => {
      setDevices(d)
      if (!selected && d.length > 0) setSelected(d[0].sampler_ip)
    })
  }, [])

  const load = useCallback(async () => {
    if (!selected) return
    setLoading(true)
    try {
      const [ts, tk] = await Promise.all([
        api.getTimeSeries({ sampler_ip: selected, window }),
        api.getTopTalkers({ sampler_ip: selected, window, limit: '100' }),
      ])
      setSeries(ts)
      setTalkers(tk)
    } finally {
      setLoading(false)
    }
  }, [selected, window])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (selected) navigate(`/devices/${encodeURIComponent(selected)}`, { replace: true })
  }, [selected])

  const handleDrillDown = (src: string, dst: string) => {
    navigate(`/explorer?src_ip=${src}&dst_ip=${dst}&window=${window}`)
  }

  const device     = devices.find(d => d.sampler_ip === selected)
  const totalBytes = talkers.reduce((s, t) => s + t.bytes, 0)
  const windowSec  = WINDOW_SECS[window]
  const chartData  = series.map(p => ({
    ts: fmtTs(p.timestamp, window),
    bytes: p.bytes,
    packets: p.packets,
    flows: p.flow_count,
  }))
  const protoDist = buildProtoDist(talkers)

  return (
    <div className="space-y-5">
      {/* Header row */}
      <div className="flex items-center gap-4 flex-wrap">
        <select
          value={selected}
          onChange={e => setSelected(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {devices.map(d => (
            <option key={d.sampler_ip} value={d.sampler_ip}>
              {d.sampler_name || d.sampler_ip} — {d.site}
            </option>
          ))}
        </select>

        {device && (
          <div className="flex items-center gap-3 text-sm text-gray-400">
            <span className="font-mono text-gray-500">{device.sampler_ip}</span>
            <span>·</span>
            <span>{fmtBytes(device.bytes_last_hour)}/hr</span>
            <span>·</span>
            <span className="text-white font-medium">{fmtBps(device.bytes_last_hour, 3600)} avg</span>
          </div>
        )}

        <div className="ml-auto flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg p-1">
          {WINDOWS.map(w => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors
                ${window === w ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >
              {w}
            </button>
          ))}
        </div>

        <button
          onClick={load}
          disabled={loading}
          className="text-gray-400 hover:text-white border border-gray-700 rounded-lg px-3 py-1.5 text-sm transition-colors disabled:opacity-50"
        >
          ↻
        </button>
      </div>

      {/* Summary stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total Bytes',    value: fmtBytes(totalBytes) },
          { label: 'Avg Throughput', value: fmtBps(totalBytes, windowSec) },
          { label: 'Unique Pairs',   value: new Set(talkers.map(t => `${t.src_ip}-${t.dst_ip}`)).size.toLocaleString() },
          { label: 'Total Flows',    value: talkers.reduce((s, t) => s + t.flow_count, 0).toLocaleString() },
        ].map(stat => (
          <div key={stat.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">{stat.label}</p>
            <p className="text-lg font-semibold text-white">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Tabs panel */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="flex border-b border-gray-800">
          {(['chart', 'talkers', 'proto'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-5 py-3 text-sm font-medium transition-colors
                ${activeTab === tab
                  ? 'text-blue-400 border-b-2 border-blue-500 -mb-px'
                  : 'text-gray-400 hover:text-white'}`}
            >
              {tab === 'chart' ? 'Traffic Chart' : tab === 'talkers' ? 'Top Talkers' : 'Protocol Mix'}
            </button>
          ))}
          {loading && (
            <div className="ml-auto flex items-center px-4">
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>

        <div className="p-5">
          {activeTab === 'chart' && (
            <div className="space-y-6">
              <div>
                <p className="text-xs text-gray-500 mb-3">Bytes per bucket</p>
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                    <defs>
                      <linearGradient id="gB" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                    <XAxis dataKey="ts" tick={{ fill: '#6b7280', fontSize: 11 }} tickLine={false} axisLine={false} />
                    <YAxis tickFormatter={v => fmtBytes(v)} tick={{ fill: '#6b7280', fontSize: 11 }} tickLine={false} axisLine={false} width={72} />
                    <Tooltip content={<TimeTooltip />} />
                    <Area type="monotone" dataKey="bytes" name="Bytes" stroke="#3b82f6" strokeWidth={2} fill="url(#gB)" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-3">Packets per bucket</p>
                <ResponsiveContainer width="100%" height={160}>
                  <AreaChart data={chartData} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
                    <defs>
                      <linearGradient id="gP" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#8b5cf6" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                    <XAxis dataKey="ts" tick={{ fill: '#6b7280', fontSize: 11 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} tickLine={false} axisLine={false} width={72} />
                    <Tooltip content={<TimeTooltip />} />
                    <Area type="monotone" dataKey="packets" name="Packets" stroke="#8b5cf6" strokeWidth={2} fill="url(#gP)" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {activeTab === 'talkers' && (
            <TopTalkersTable talkers={talkers} totalBytes={totalBytes} onDrillDown={handleDrillDown} />
          )}

          {activeTab === 'proto' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <p className="text-xs text-gray-500 mb-3">Bytes by protocol</p>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={protoDist} layout="vertical" margin={{ left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" horizontal={false} />
                    <XAxis type="number" tickFormatter={v => fmtBytes(v)} tick={{ fill: '#6b7280', fontSize: 11 }} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="name" tick={{ fill: '#9ca3af', fontSize: 12 }} tickLine={false} axisLine={false} width={56} />
                    <Tooltip formatter={(v: number) => fmtBytes(v)} contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }} labelStyle={{ color: '#9ca3af' }} />
                    <Bar dataKey="bytes" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-3">Protocol breakdown</p>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800">
                      <th className="py-2 text-left text-xs text-gray-400">Protocol</th>
                      <th className="py-2 text-right text-xs text-gray-400">Bytes</th>
                      <th className="py-2 text-right text-xs text-gray-400">Share</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/50">
                    {protoDist.map(p => (
                      <tr key={p.name}>
                        <td className="py-2.5 text-white font-medium">{p.name}</td>
                        <td className="py-2.5 text-right text-gray-300">{fmtBytes(p.bytes)}</td>
                        <td className="py-2.5 text-right text-gray-400">
                          {totalBytes > 0 ? ((p.bytes / totalBytes) * 100).toFixed(1) + '%' : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
