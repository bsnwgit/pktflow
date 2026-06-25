/**
 * Ports — Traffic by Port analytics page
 * Panels:
 *   1. Protocol mix (pie chart)
 *   2. Top ports by bytes / flows (bar chart)
 *   3. Traffic over time (area chart, optionally pinned to a port)
 *   4. Full port inventory table
 */
import { useEffect, useState, useCallback } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend,
  AreaChart, Area,
} from 'recharts'
import { api, ProtocolStat, PortStat, DeviceSummary, FlowRecord } from '../api/client'
import { useAutoRefresh } from '../store/autoRefresh'
import { protoLabel } from '../utils/protocols'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB'
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB'
  return b + ' B'
}

function fmtNum(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K'
  return String(n)
}

const PROTO_COLORS: Record<string, string> = {
  TCP: '#3b82f6', UDP: '#8b5cf6', ICMP: '#10b981',
  GRE: '#f59e0b', ESP: '#ef4444',
}
const BAR_COLORS = ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#06b6d4','#ec4899','#84cc16']

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

// ── Inline Port Flows (drill-down sub-row) ─────────────────────────────────────

function InlinePortFlows({
  port, protocol, protoName, window, sampler_ip,
}: {
  port: number; protocol: number; protoName: string
  window: string; sampler_ip?: string
}) {
  const [flows, setFlows]     = useState<FlowRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  useEffect(() => {
    setLoading(true)
    setError('')
    const params: any = { dst_port: String(port), protocol: String(protocol), window, limit: '20' }
    if (sampler_ip) params.sampler_ip = sampler_ip
    api.searchFlows(params)
      .then(f => { setFlows(f ?? []); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [port, protocol, window, sampler_ip])

  const colSpan = 9

  if (loading) return (
    <tr><td colSpan={colSpan} className="px-6 py-3 bg-gray-950">
      <div className="flex items-center gap-2 text-xs text-white">
        <div className="w-3 h-3 border border-blue-500 border-t-transparent rounded-full animate-spin" />
        Loading flows…
      </div>
    </td></tr>
  )

  if (error) return (
    <tr><td colSpan={colSpan} className="px-6 py-3 bg-gray-950 text-xs text-red-400">{error}</td></tr>
  )

  if (!flows.length) return (
    <tr><td colSpan={colSpan} className="px-6 py-3 bg-gray-950 text-xs text-white italic">No flows found for this port</td></tr>
  )

  return (
    <tr>
      <td colSpan={colSpan} className="px-0 py-0 bg-gray-950 border-b border-gray-800">
        <div className="px-6 py-3">
          <p className="text-xs text-blue-300 mb-2 font-medium">
            {flows.length} recent flows — port {port}/{protoName}
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-white border-b border-gray-800">
                <th className="pb-1 text-left pr-4">Time</th>
                <th className="pb-1 text-left pr-4">Source IP</th>
                <th className="pb-1 text-left pr-4">Src Port</th>
                <th className="pb-1 text-left pr-4">Destination IP</th>
                <th className="pb-1 text-left pr-4">Proto</th>
                <th className="pb-1 text-right pr-4">Bytes</th>
                <th className="pb-1 text-right pr-4">Packets</th>
                <th className="pb-1 text-right">Duration</th>
              </tr>
            </thead>
            <tbody>
              {flows.map((f, i) => (
                <tr key={i} className="border-b border-gray-800/40 hover:bg-gray-800/30">
                  <td className="py-1 pr-4 text-white">{new Date(f.timestamp).toLocaleTimeString()}</td>
                  <td className="py-1 pr-4 font-mono text-blue-300">{f.src_ip}</td>
                  <td className="py-1 pr-4 font-mono text-white">{f.src_port}</td>
                  <td className="py-1 pr-4 font-mono text-purple-300">{f.dst_ip}</td>
                  <td className="py-1 pr-4">
                    <span className="bg-gray-800 text-white px-1.5 py-0.5 rounded">{protoLabel(f.protocol)}</span>
                  </td>
                  <td className="py-1 pr-4 text-right text-white">{fmtBytes(f.bytes)}</td>
                  <td className="py-1 pr-4 text-right text-white">{f.packets.toLocaleString()}</td>
                  <td className="py-1 text-right text-white">{fmtDuration(f.duration_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </td>
    </tr>
  )
}

// ── Shared sub-components ──────────────────────────────────────────────────────

function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-3">
      {title && <p className="text-sm font-semibold text-white">{title}</p>}
      {children}
    </div>
  )
}

const WINDOWS = ['1h','6h','24h','7d','30d']

function WindowPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-1">
      {WINDOWS.map(w => (
        <button
          key={w}
          onClick={() => onChange(w)}
          className={`text-xs px-2.5 py-1 rounded-lg transition-colors ${
            value === w ? 'bg-blue-600 text-white' : 'bg-gray-800 text-white hover:bg-gray-700'
          }`}
        >
          {w}
        </button>
      ))}
    </div>
  )
}

// ── Protocol Mix Panel ─────────────────────────────────────────────────────────

function ProtocolMixPanel({ window, sampler_ip }: { window: string; sampler_ip?: string }) {
  const [data, setData] = useState<ProtocolStat[]>([])

  useEffect(() => {
    api.getProtocolStats({ window, sampler_ip }).then(setData).catch(() => {})
  }, [window, sampler_ip])

  if (!data.length) return <div className="h-40 flex items-center justify-center text-white text-sm">No data</div>

  const pieData = data.map(d => ({ name: d.name, value: d.bytes }))
  return (
    <div className="h-44">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70}>
            {pieData.map((_, i) => (
              <Cell key={i} fill={PROTO_COLORS[pieData[i].name] || BAR_COLORS[i % BAR_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(v: any) => fmtBytes(Number(v))} contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }} labelStyle={{ color: '#9ca3af' }} itemStyle={{ color: '#fff' }} />
          <Legend iconSize={8} wrapperStyle={{ fontSize: 11, color: '#fff' }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Top Ports Panel ────────────────────────────────────────────────────────────

function TopPortsPanel({
  window, sampler_ip, site, metric, onPortClick,
}: {
  window: string; sampler_ip?: string; site?: string
  metric: 'bytes' | 'flows'
  onPortClick: (port: number, proto: number) => void
}) {
  const [data, setData] = useState<PortStat[]>([])

  useEffect(() => {
    const params: any = { window, limit: '12' }
    if (sampler_ip) params.sampler_ip = sampler_ip
    if (site) params.site = site
    api.getTopPorts(params).then(setData).catch(() => {})
  }, [window, sampler_ip, site])

  if (!data.length) return <div className="h-40 flex items-center justify-center text-white text-sm">No data</div>

  const chartData = data.map(d => ({
    label: d.service_name || `${d.proto_name}:${d.port}`,
    value: metric === 'bytes' ? d.bytes : d.flow_count,
    port: d.port, protocol: d.protocol,
  }))

  return (
    <div className="h-44">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 8, top: 0, bottom: 0 }}>
          <XAxis type="number" tick={{ fill: '#fff', fontSize: 10 }} tickFormatter={metric === 'bytes' ? fmtBytes : fmtNum} />
          <YAxis type="category" dataKey="label" tick={{ fill: '#fff', fontSize: 10 }} width={70} />
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,0.05)' }}
            contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: '#9ca3af' }}
            itemStyle={{ color: '#fff' }}
            formatter={(v: any) => metric === 'bytes' ? fmtBytes(Number(v)) : fmtNum(Number(v))}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} onClick={(d: any) => onPortClick(d.port, d.protocol)}>
            {chartData.map((_, i) => <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Traffic Timeline Panel ─────────────────────────────────────────────────────

function TrafficTimelinePanel({
  window, sampler_ip, site, pinnedPort, pinnedProtocol, onClear,
}: {
  window: string; sampler_ip?: string; site?: string
  pinnedPort: number | null; pinnedProtocol: number | null
  onClear: () => void
}) {
  const [data, setData] = useState<any[]>([])

  useEffect(() => {
    const params: any = { window }
    if (sampler_ip) params.sampler_ip = sampler_ip
    if (site) params.site = site
    if (pinnedPort) params.dst_port = String(pinnedPort)
    if (pinnedProtocol) params.protocol = String(pinnedProtocol)
    api.getTimeSeries(params).then(setData).catch(() => {})
  }, [window, sampler_ip, site, pinnedPort, pinnedProtocol])

  return (
    <div className="flex flex-col gap-2">
      {pinnedPort !== null && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-blue-300">Pinned: port {pinnedPort}</span>
          <button onClick={onClear} className="text-xs text-white hover:text-white">clear</button>
        </div>
      )}
      <div className="h-36">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="portGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="timestamp" hide />
            <YAxis hide />
            <Tooltip
              contentStyle={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#9ca3af' }}
              itemStyle={{ color: '#fff' }}
              formatter={(v: any) => fmtBytes(Number(v))}
              labelFormatter={(l: any) => new Date(l).toLocaleTimeString()}
            />
            <Area type="monotone" dataKey="bytes" stroke="#3b82f6" fill="url(#portGrad)" strokeWidth={1.5} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ── Port Inventory Table ───────────────────────────────────────────────────────

function PortInventoryTable({ window, sampler_ip, site }: { window: string; sampler_ip?: string; site?: string }) {
  const [data, setData] = useState<PortStat[]>([])
  type PortSortKey = 'port' | 'proto_name' | 'service_name' | 'bytes' | 'packets' | 'flow_count' | 'pct_bytes'
  const [sortKey, setSortKey] = useState<PortSortKey>('bytes')
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')
  const [search, setSearch] = useState('')
  const [expandedKey, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    const params: any = { window, limit: '500' }
    if (sampler_ip) params.sampler_ip = sampler_ip
    if (site) params.site = site
    api.getTopPorts(params).then(setData).catch(() => {})
  }, [window, sampler_ip, site])

  const toggle = (k: PortSortKey) => {
    if (sortKey === k) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(k); setSortDir('desc') }
  }

  const filtered = data
    .filter(d => {
      if (!search) return true
      const s = search.toLowerCase()
      return String(d.port).includes(s) || d.service_name.toLowerCase().includes(s) || d.proto_name.toLowerCase().includes(s)
    })
    .sort((a, b) => {
      const av = a[sortKey] as any
      const bv = b[sortKey] as any
      if (typeof av === 'string')
        return sortDir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv)
      return sortDir === 'desc' ? bv - av : av - bv
    })

  const SortTh = ({ k, label, cls }: { k: PortSortKey; label: string; cls?: string }) => (
    <th
      onClick={() => toggle(k)}
      className={`px-4 py-2.5 text-left text-xs cursor-pointer select-none transition-colors
        ${sortKey === k ? 'text-blue-400' : 'text-white hover:text-gray-200'} ${cls ?? ''}`}
    >
      {label}{sortKey === k && <span className="ml-1">{sortDir === 'desc' ? '↓' : '↑'}</span>}
    </th>
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter by port, service, or protocol…"
          className="bg-gray-800 border border-gray-700 text-white text-xs rounded-lg px-3 py-1.5 w-64 focus:outline-none focus:border-blue-500 placeholder:text-white"
        />
        <button onClick={() => setSearch('')} className="text-red-400 hover:text-red-300 transition-colors text-sm font-bold">✕</button>
        <span className="text-xs text-white">{filtered.length} ports</span>
      </div>
      <div className="overflow-hidden rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 bg-gray-900">
              <th className="px-4 py-2.5 w-6" />
              <SortTh k="port"         label="Port" />
              <SortTh k="proto_name"   label="Protocol" />
              <SortTh k="service_name" label="Service" />
              <SortTh k="bytes"        label="Bytes" />
              <SortTh k="packets"      label="Packets" />
              <SortTh k="flow_count"   label="Flows" />
              <SortTh k="pct_bytes"    label="% Traffic" />
              <th className="px-4 py-2.5 w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50 bg-gray-900">
            {filtered.map((row, i) => {
              const rowKey = `${row.port}-${row.protocol}`
              const isExpanded = expandedKey === rowKey
              return (
                <>
                  <tr
                    key={rowKey}
                    className={`hover:bg-gray-800/40 transition-colors cursor-pointer ${isExpanded ? 'bg-gray-800/30' : ''}`}
                    onClick={() => setExpanded(isExpanded ? null : rowKey)}
                  >
                    <td className="px-4 py-2 text-white text-xs select-none">{isExpanded ? '▼' : '▶'}</td>
                    <td className="px-4 py-2 font-mono text-white">{row.port}</td>
                    <td className="px-4 py-2 text-white">{row.proto_name}</td>
                    <td className="px-4 py-2 text-white">{row.service_name || '—'}</td>
                    <td className="px-4 py-2 text-white">{fmtBytes(row.bytes)}</td>
                    <td className="px-4 py-2 text-white">{fmtNum(row.packets)}</td>
                    <td className="px-4 py-2 text-white">{fmtNum(row.flow_count)}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <div className="w-16 bg-gray-800 rounded-full h-1.5">
                          <div className="bg-blue-500 h-1.5 rounded-full" style={{ width: `${Math.min(row.pct_bytes, 100)}%` }} />
                        </div>
                        <span className="text-white text-xs">{row.pct_bytes.toFixed(1)}%</span>
                      </div>
                    </td>
                    <td className="px-2 py-2" onClick={e => e.stopPropagation()}>
                      <a
                        href={`/explorer?dst_port=${row.port}&protocol=${row.protocol}&window=${window}${sampler_ip ? `&sampler=${encodeURIComponent(sampler_ip)}` : ''}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-400 hover:text-blue-300 transition-colors"
                        title="View in Flow Explorer"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                        </svg>
                      </a>
                    </td>
                  </tr>
                  {isExpanded && (
                    <InlinePortFlows
                      key={`flows-${rowKey}`}
                      port={row.port}
                      protocol={row.protocol}
                      protoName={row.proto_name}
                      window={window}
                      sampler_ip={sampler_ip}
                    />
                  )}
                </>
              )
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-white text-sm italic">No ports found</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Ports Tab (embeddable in DeviceView) ──────────────────────────────────────

export function PortsTabContent({ sampler_ip, window }: { sampler_ip: string; window: string }) {
  const [topMetric, setTopMetric]   = useState<'bytes' | 'flows'>('bytes')
  const [pinnedPort, setPinnedPort] = useState<number | null>(null)
  const [pinnedProto, setPinnedProto] = useState<number | null>(null)

  const handlePortClick = useCallback((port: number, proto: number) => {
    setPinnedPort(port); setPinnedProto(proto)
  }, [])

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Top Ports by Volume">
          <div className="flex items-center gap-2 self-end -mt-1">
            {(['bytes','flows'] as const).map(m => (
              <button key={m} onClick={() => setTopMetric(m)}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${topMetric === m ? 'bg-blue-600 text-white' : 'bg-gray-800 text-white hover:text-white'}`}>
                {m === 'bytes' ? 'Bytes' : 'Flows'}
              </button>
            ))}
          </div>
          <p className="text-xs text-white -mt-2">Click a bar to pin the traffic timeline to that port.</p>
          <TopPortsPanel window={window} sampler_ip={sampler_ip} metric={topMetric} onPortClick={handlePortClick} />
        </Card>
        <Card title="Traffic Over Time">
          <TrafficTimelinePanel
            window={window} sampler_ip={sampler_ip}
            pinnedPort={pinnedPort} pinnedProtocol={pinnedProto}
            onClear={() => { setPinnedPort(null); setPinnedProto(null) }}
          />
        </Card>
      </div>
      <Card title="Port Inventory">
        <PortInventoryTable window={window} sampler_ip={sampler_ip} />
      </Card>
    </div>
  )
}

// ── Main Ports page ────────────────────────────────────────────────────────────

export default function Ports() {
  const [window, setWindow] = useState('24h')
  const [samplerFilter, setSamplerFilter] = useState('')
  const [siteFilter, setSiteFilter] = useState('')
  const [topMetric, setTopMetric] = useState<'bytes' | 'flows'>('bytes')
  const [pinnedPort, setPinnedPort] = useState<number | null>(null)
  const [pinnedProto, setPinnedProto] = useState<number | null>(null)
  const [samplers, setSamplers] = useState<DeviceSummary[]>([])
  const [sites, setSites] = useState<string[]>([])

  useEffect(() => {
    api.getDeviceSummaries().then(devs => {
      setSamplers(devs)
      const unique = Array.from(new Set(devs.map(d => d.site).filter(Boolean)))
      setSites(unique)
    }).catch(() => {})
  }, [])

  const handlePortClick = useCallback((port: number, proto: number) => {
    setPinnedPort(port)
    setPinnedProto(proto)
  }, [])

  const clearPin = useCallback(() => {
    setPinnedPort(null)
    setPinnedProto(null)
  }, [])

  const { tick } = useAutoRefresh()
  useEffect(() => { if (tick > 0) { /* child panels re-fetch via prop changes */ } }, [tick])

  // sampler filter and site filter are mutually exclusive in the UI
  const activeSampler = samplerFilter
  const activeSite    = !samplerFilter ? siteFilter : ''

  return (
    <div className="flex flex-col gap-4 min-h-0">

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <WindowPicker value={window} onChange={setWindow} />

        <select
          value={samplerFilter}
          onChange={e => { setSamplerFilter(e.target.value); if (e.target.value) setSiteFilter('') }}
          className="bg-gray-800 border border-gray-700 text-white text-xs rounded-lg px-2 py-1 focus:outline-none focus:border-blue-500"
        >
          <option value="">All samplers</option>
          {samplers.map(s => (
            <option key={s.sampler_ip} value={s.sampler_ip}>
              {s.sampler_name || s.sampler_ip}
            </option>
          ))}
        </select>

        <select
          value={siteFilter}
          onChange={e => { setSiteFilter(e.target.value); if (e.target.value) setSamplerFilter('') }}
          className="bg-gray-800 border border-gray-700 text-white text-xs rounded-lg px-2 py-1 focus:outline-none focus:border-blue-500"
        >
          <option value="">All sites</option>
          {sites.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* ── Top row: protocol mix + top ports ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Protocol Mix">
          <ProtocolMixPanel window={window} sampler_ip={activeSampler} />
        </Card>

        <Card title="Top Ports by Volume">
          <div className="flex items-center gap-2 self-end -mt-1">
            {(['bytes','flows'] as const).map(m => (
              <button
                key={m}
                onClick={() => setTopMetric(m)}
                className={`text-xs px-2 py-0.5 rounded transition-colors ${
                  topMetric === m ? 'bg-blue-600 text-white' : 'bg-gray-800 text-white hover:text-white'
                }`}
              >
                {m === 'bytes' ? 'Bytes' : 'Flows'}
              </button>
            ))}
          </div>
          <p className="text-xs text-white -mt-2">Click a bar to pin the traffic timeline to that port.</p>
          <TopPortsPanel
            window={window}
            sampler_ip={activeSampler}
            site={activeSite}
            metric={topMetric}
            onPortClick={handlePortClick}
          />
        </Card>
      </div>

      {/* ── Traffic over time ────────────────────────────────────────────── */}
      <Card title="Traffic Over Time">
        <TrafficTimelinePanel
          window={window}
          sampler_ip={activeSampler}
          site={activeSite}
          pinnedPort={pinnedPort}
          pinnedProtocol={pinnedProto}
          onClear={clearPin}
        />
      </Card>

      {/* ── Port inventory table ─────────────────────────────────────────── */}
      <Card title="Port Inventory">
        <PortInventoryTable
          window={window}
          sampler_ip={activeSampler}
          site={activeSite}
        />
      </Card>

    </div>
  )
}
