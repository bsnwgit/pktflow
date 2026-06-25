import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import { api, DeviceSummary, TimeSeriesPoint, TopTalker, FlowRecord } from '../api/client'
import { PortsTabContent } from './Ports'
import { protoLabel } from '../utils/protocols'

// ── Helpers ───────────────────────────────────────────────────────────────────

const WINDOWS = ['1h', '6h', '24h', '7d', '30d'] as const
type Window = typeof WINDOWS[number]

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

function fmtDuration(ms: number): string {
  if (ms >= 60000) return (ms / 60000).toFixed(1) + 'm'
  if (ms >= 1000)  return (ms / 1000).toFixed(1) + 's'
  return ms + 'ms'
}

const PIE_COLORS = ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#06b6d4','#ec4899','#84cc16']

function buildProtoDist(talkers: TopTalker[]) {
  const map: Record<string, number> = {}
  for (const t of talkers) {
    const label = protoLabel(t.protocol)
    map[label] = (map[label] ?? 0) + t.bytes
  }
  return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([name, bytes]) => ({ name, bytes }))
}

function buildSrcDist(talkers: TopTalker[]) {
  const map: Record<string, number> = {}
  for (const t of talkers) {
    map[t.src_ip] = (map[t.src_ip] ?? 0) + t.bytes
  }
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, bytes]) => ({ name, bytes }))
}

function buildDstDist(talkers: TopTalker[]) {
  const map: Record<string, number> = {}
  for (const t of talkers) {
    map[t.dst_ip] = (map[t.dst_ip] ?? 0) + t.bytes
  }
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, bytes]) => ({ name, bytes }))
}

function buildPortDist(talkers: TopTalker[]) {
  const map: Record<string, number> = {}
  for (const t of talkers) {
    const label = `${t.dst_port}/${protoLabel(t.protocol)}`
    map[label] = (map[label] ?? 0) + t.bytes
  }
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, bytes]) => ({ name, bytes }))
}

function TimeTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-white mb-2">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-white">{p.name}:</span>
          <span className="text-white font-medium">
            {p.dataKey === 'bytes' ? fmtBytes(p.value) : p.value.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Inline Flow Drill-Down ────────────────────────────────────────────────────

function InlineFlows({ srcIp, dstIp, window }: { srcIp: string; dstIp: string; window: Window }) {
  const [flows, setFlows]     = useState<FlowRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  useEffect(() => {
    setLoading(true)
    setError('')
    api.searchFlows({ src_ip: srcIp, dst_ip: dstIp, window, limit: '20' })
      .then(f => { setFlows(f ?? []); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [srcIp, dstIp, window])

  if (loading) return (
    <tr><td colSpan={9} className="px-6 py-3 bg-gray-950">
      <div className="flex items-center gap-2 text-xs text-white">
        <div className="w-3 h-3 border border-blue-500 border-t-transparent rounded-full animate-spin" />
        Loading flows…
      </div>
    </td></tr>
  )

  if (error) return (
    <tr><td colSpan={9} className="px-6 py-3 bg-gray-950 text-xs text-red-400">{error}</td></tr>
  )

  if (!flows.length) return (
    <tr><td colSpan={9} className="px-6 py-3 bg-gray-950 text-xs text-white italic">No flows found</td></tr>
  )

  return (
    <tr>
      <td colSpan={9} className="px-0 py-0 bg-gray-950 border-b border-gray-800">
        <div className="px-6 py-3">
          <p className="text-xs text-blue-300 mb-2 font-medium">{flows.length} flows — {srcIp} → {dstIp}</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-white border-b border-gray-800">
                <th className="pb-1 text-left pr-4">Time</th>
                <th className="pb-1 text-left pr-4">Src Port</th>
                <th className="pb-1 text-left pr-4">Dst Port</th>
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
                  <td className="py-1 pr-4 font-mono text-white">{f.src_port}</td>
                  <td className="py-1 pr-4 font-mono text-white">{f.dst_port}</td>
                  <td className="py-1 pr-4">
                    <span className="bg-gray-800 text-white px-1.5 py-0.5 rounded text-xs">{protoLabel(f.protocol)}</span>
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

// ── Talker Pie Charts ─────────────────────────────────────────────────────────

function TalkerPieCharts({ talkers, totalBytes }: { talkers: TopTalker[]; totalBytes: number }) {
  const protoDist = buildProtoDist(talkers)
  const srcDist   = buildSrcDist(talkers)
  const dstDist   = buildDstDist(talkers)
  const portDist  = buildPortDist(talkers)

  const PieTip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null
    const { name, value } = payload[0]
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-2 text-xs shadow-xl">
        <p className="text-white font-medium">{name}</p>
        <p className="text-white">{fmtBytes(value)}</p>
        {totalBytes > 0 && <p className="text-white">{((value / totalBytes) * 100).toFixed(1)}%</p>}
      </div>
    )
  }

  const PieCard = ({ title, data, mono = false }: { title: string; data: { name: string; bytes: number }[]; mono?: boolean }) => (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs text-white mb-2 font-medium">{title}</p>
      <div className="flex items-center gap-2">
        <ResponsiveContainer width="50%" height={120}>
          <PieChart>
            <Pie data={data} dataKey="bytes" nameKey="name" cx="50%" cy="50%"
              innerRadius={28} outerRadius={52} paddingAngle={2}>
              {data.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
            </Pie>
            <Tooltip content={<PieTip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="flex flex-col gap-1 flex-1 min-w-0">
          {data.slice(0, 5).map((d, i) => (
            <div key={d.name} className="flex items-center gap-1.5 text-xs">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
              <span className={`${mono ? 'font-mono' : ''} text-white truncate flex-1`}>{d.name}</span>
              <span className="text-white shrink-0">{totalBytes > 0 ? ((d.bytes / totalBytes) * 100).toFixed(0) + '%' : '-'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
      <PieCard title="By Protocol"      data={protoDist} />
      <PieCard title="Top Sources"      data={srcDist}   mono />
      <PieCard title="Top Destinations" data={dstDist}   mono />
      <PieCard title="Top Ports"        data={portDist}  mono />
    </div>
  )
}

// ── Top Talkers Table ─────────────────────────────────────────────────────────

function TopTalkersTable({ talkers, totalBytes, window, externalExpanded, onExternalExpandedConsumed }: {
  talkers: TopTalker[]
  totalBytes: number
  window: Window
  externalExpanded?: string | null
  onExternalExpandedConsumed?: () => void
}) {
  const navigate = useNavigate()
  type TalkerSortKey = keyof TopTalker
  const [sortKey, setSortKey]     = useState<TalkerSortKey>('bytes')
  const [sortDir, setSortDir]     = useState<'asc' | 'desc'>('desc')
  const [expandedKey, setExpanded] = useState<string | null>(null)
  const [filter, setFilter]       = useState('')

  useEffect(() => {
    if (externalExpanded) {
      setExpanded(externalExpanded)
      onExternalExpandedConsumed?.()
    }
  }, [externalExpanded])

  const toggleSort = (key: TalkerSortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir(key === 'src_ip' || key === 'dst_ip' || key === 'protocol' ? 'asc' : 'desc') }
  }

  const sorted = [...talkers].sort((a, b) => {
    const av = a[sortKey] as any
    const bv = b[sortKey] as any
    if (typeof av === 'number' && typeof bv === 'number')
      return sortDir === 'asc' ? av - bv : bv - av
    return sortDir === 'asc'
      ? String(av ?? '').localeCompare(String(bv ?? ''))
      : String(bv ?? '').localeCompare(String(av ?? ''))
  })

  const displayed = filter.trim()
    ? sorted.filter(t => {
        const q = filter.toLowerCase()
        return t.src_ip.includes(q) || t.dst_ip.includes(q) ||
          protoLabel(t.protocol).toLowerCase().includes(q) ||
          String(t.dst_port).includes(q)
      })
    : sorted

  const Col = ({ col, label }: { col: TalkerSortKey; label: string }) => (
    <th
      className={`px-4 py-3 text-left text-xs font-medium cursor-pointer select-none transition-colors
        ${sortKey === col ? 'text-blue-400' : 'text-white hover:text-gray-200'}`}
      onClick={() => toggleSort(col)}
    >
      {label}{sortKey === col && <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>}
    </th>
  )

  return (
    <div>
      <TalkerPieCharts talkers={talkers} totalBytes={totalBytes} />
      <p className="text-sm font-semibold text-white mb-3">Top Talkers</p>
      <div className="flex items-center gap-3 mb-3 px-1">
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter by IP, port, or protocol…"
          className="bg-gray-800 border border-gray-700 text-white text-xs rounded-lg px-3 py-1.5 w-64 focus:outline-none focus:border-blue-500 placeholder:text-white"
        />
        <button onClick={() => setFilter('')} className="text-red-400 hover:text-red-300 transition-colors text-sm font-bold">✕</button>
        <span className="text-xs text-white">{displayed.length} talkers</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="px-4 py-3 text-left text-xs font-medium text-white w-6" />
              <Col col="src_ip" label="Source IP" />
              <Col col="dst_ip" label="Destination IP" />
              <Col col="dst_port" label="Port" />
              <Col col="protocol" label="Proto" />
              <Col col="bytes" label="Bytes" />
              <Col col="packets" label="Packets" />
              <Col col="flow_count" label="Flows" />
              <th className="px-4 py-3 text-left text-xs font-medium text-white">Share</th>
              <th className="px-4 py-3 w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50">
            {displayed.map((t, i) => {
              const rowKey = `${t.src_ip}-${t.dst_ip}-${t.dst_port}-${t.protocol}`
              const isExpanded = expandedKey === rowKey
              const pct = totalBytes > 0 ? ((t.bytes / totalBytes) * 100).toFixed(1) : '0'
              return (
                <>
                  <tr
                    key={rowKey}
                    className={`hover:bg-gray-800/40 transition-colors cursor-pointer ${isExpanded ? 'bg-gray-800/30' : ''}`}
                    onClick={() => setExpanded(isExpanded ? null : rowKey)}
                  >
                    <td className="px-4 py-2.5 text-white text-xs select-none">
                      {isExpanded ? '▼' : '▶'}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-blue-300 text-xs">{t.src_ip}</td>
                    <td className="px-4 py-2.5 font-mono text-purple-300 text-xs">{t.dst_ip}</td>
                    <td className="px-4 py-2.5 text-white">{t.dst_port}</td>
                    <td className="px-4 py-2.5">
                      <span className="bg-gray-800 text-white text-xs px-2 py-0.5 rounded">
                        {protoLabel(t.protocol)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-white font-medium">{fmtBytes(t.bytes)}</td>
                    <td className="px-4 py-2.5 text-white">{t.packets.toLocaleString()}</td>
                    <td className="px-4 py-2.5 text-white">{t.flow_count.toLocaleString()}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="w-14 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.min(100, parseFloat(pct))}%` }} />
                        </div>
                        <span className="text-white text-xs">{pct}%</span>
                      </div>
                    </td>
                    <td className="px-2 py-2.5" onClick={e => e.stopPropagation()}>
                      <a
                        href={`/explorer?src_ip=${encodeURIComponent(t.src_ip)}&dst_ip=${encodeURIComponent(t.dst_ip)}&dst_port=${t.dst_port}&protocol=${t.protocol}&window=${window}`}
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
                    <InlineFlows key={`flows-${rowKey}`} srcIp={t.src_ip} dstIp={t.dst_ip} window={window} />
                  )}
                </>
              )
            })}
          </tbody>
        </table>
        {displayed.length === 0 && (
          <div className="text-center py-12 text-white">
            {filter ? 'No results match this filter' : 'No flow data for this window'}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Sankey Flow Diagram ───────────────────────────────────────────────────────

const SANKEY_PORT_GROUPS: Array<{ label: string; ports: Set<number>; color: string }> = [
  { label: 'HTTPS',    ports: new Set([443, 8443]),                                 color: '#8b5cf6' },
  { label: 'HTTP',     ports: new Set([80, 8080, 8000]),                            color: '#14b8a6' },
  { label: 'DNS',      ports: new Set([53]),                                         color: '#10b981' },
  { label: 'SSH',      ports: new Set([22]),                                         color: '#f59e0b' },
  { label: 'Database', ports: new Set([3306, 5432, 1433, 5433, 27017, 6379, 5984]), color: '#ec4899' },
  { label: 'RDP',      ports: new Set([3389]),                                       color: '#ef4444' },
  { label: 'Email',    ports: new Set([25, 587, 465, 143, 993, 110, 995]),           color: '#f97316' },
]
const SANKEY_UDP_COLOR   = '#06b6d4' // cyan — all UDP except DNS
const SANKEY_OTHER_COLOR = '#6b7280' // gray — unmatched TCP

interface SankeyNode { key: string; bytes: number; x: number; y: number; h: number }
interface SankeyLink { color: string; x0: number; y0: number; w0: number; x1: number; y1: number; w1: number; bytes: number; flow?: TopTalker }

function buildSankeyLayout(talkers: TopTalker[], W: number, H: number) {
  const PADDING = 6
  const COL_W   = 110
  const TOP_N   = 10

  const flows = talkers.slice(0, 25)

  // Aggregate by key
  const aggMap = (keyFn: (t: TopTalker) => string) => {
    const m = new Map<string, number>()
    for (const t of flows) m.set(keyFn(t), (m.get(keyFn(t)) ?? 0) + t.bytes)
    return m
  }

  const srcAgg  = aggMap(t => t.src_ip)
  const portAgg = aggMap(t => `${protoLabel(t.protocol)}:${t.dst_port}`)
  const dstAgg  = aggMap(t => t.dst_ip)

  const layoutCol = (map: Map<string, number>, x: number): SankeyNode[] => {
    const entries = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N)
    const total   = entries.reduce((s, [, v]) => s + v, 0)
    const avail   = H - PADDING * (entries.length - 1)
    let y = 0
    return entries.map(([key, bytes]) => {
      const h = Math.max(12, (bytes / total) * avail)
      const node = { key, bytes, x, y, h }
      y += h + PADDING
      return node
    })
  }

  const srcNodes  = layoutCol(srcAgg,  0)
  const portNodes = layoutCol(portAgg, (W - COL_W) / 2)
  const dstNodes  = layoutCol(dstAgg,  W - COL_W)

  const linkColor = (t: TopTalker) => {
    // UDP (except DNS port 53) gets its own color regardless of port
    if (t.protocol === 17 && t.dst_port !== 53) return SANKEY_UDP_COLOR
    // Port-group matching for TCP / ICMP / others
    for (const g of SANKEY_PORT_GROUPS) {
      if (g.ports.has(t.dst_port)) return g.color
    }
    return SANKEY_OTHER_COLOR
  }

  // Track current y-offsets within each node for stacking links
  const srcY  = Object.fromEntries(srcNodes.map(n  => [n.key, n.y]))
  const portInY  = Object.fromEntries(portNodes.map(n => [n.key, n.y]))
  const portOutY = Object.fromEntries(portNodes.map(n => [n.key, n.y]))
  const dstY  = Object.fromEntries(dstNodes.map(n  => [n.key, n.y]))

  const getNodeH = (nodes: SankeyNode[], key: string) => nodes.find(n => n.key === key)?.h ?? 0
  const getNodeBytes = (nodes: SankeyNode[], key: string) => nodes.find(n => n.key === key)?.bytes ?? 1

  const links1: SankeyLink[] = []
  const links2: SankeyLink[] = []

  // Sort flows by src, then port for deterministic stacking
  const sorted = [...flows].sort((a, b) => a.src_ip.localeCompare(b.src_ip))

  for (const t of sorted) {
    const portKey = `${protoLabel(t.protocol)}:${t.dst_port}`
    if (!(t.src_ip in srcY) || !(portKey in portInY)) continue

    const srcNode   = srcNodes.find(n => n.key === t.src_ip)
    const portNode  = portNodes.find(n => n.key === portKey)
    if (!srcNode || !portNode) continue

    const srcH  = getNodeH(srcNodes, t.src_ip)
    const srcB  = getNodeBytes(srcNodes, t.src_ip)
    const w     = Math.max(1, (t.bytes / srcB) * srcH)
    const portH = getNodeH(portNodes, portKey)
    const portB = getNodeBytes(portNodes, portKey)
    const wIn   = Math.max(1, (t.bytes / portB) * portH)

    links1.push({
      color: linkColor(t),
      x0: COL_W, y0: srcY[t.src_ip],  w0: w,
      x1: portNode.x, y1: portInY[portKey], w1: wIn,
      bytes: t.bytes,
      flow: t,
    })
    srcY[t.src_ip]  += w
    portInY[portKey] += wIn
  }

  const sorted2 = [...flows].sort((a, b) => a.dst_ip.localeCompare(b.dst_ip))
  for (const t of sorted2) {
    const portKey = `${protoLabel(t.protocol)}:${t.dst_port}`
    if (!(portKey in portOutY) || !(t.dst_ip in dstY)) continue

    const portNode = portNodes.find(n => n.key === portKey)
    const dstNode  = dstNodes.find(n => n.key === t.dst_ip)
    if (!portNode || !dstNode) continue

    const portH = getNodeH(portNodes, portKey)
    const portB = getNodeBytes(portNodes, portKey)
    const wOut  = Math.max(1, (t.bytes / portB) * portH)
    const dstH  = getNodeH(dstNodes, t.dst_ip)
    const dstB  = getNodeBytes(dstNodes, t.dst_ip)
    const wDst  = Math.max(1, (t.bytes / dstB) * dstH)

    links2.push({
      color: linkColor(t),
      x0: portNode.x + COL_W, y0: portOutY[portKey], w0: wOut,
      x1: W - COL_W, y1: dstY[t.dst_ip], w1: wDst,
      bytes: t.bytes,
      flow: t,
    })
    portOutY[portKey] += wOut
    dstY[t.dst_ip]    += wDst
  }

  return { srcNodes, portNodes, dstNodes, links1, links2, COL_W }
}

function SankeyBand({ link, onClick }: { link: SankeyLink; onClick?: () => void }) {
  const [hovered, setHovered] = useState(false)
  const mx = (link.x0 + link.x1) / 2
  const path = `
    M ${link.x0} ${link.y0}
    C ${mx} ${link.y0}, ${mx} ${link.y1}, ${link.x1} ${link.y1}
    L ${link.x1} ${link.y1 + link.w1}
    C ${mx} ${link.y1 + link.w1}, ${mx} ${link.y0 + link.w0}, ${link.x0} ${link.y0 + link.w0}
    Z
  `
  return (
    <path
      d={path}
      fill={link.color}
      fillOpacity={hovered ? 0.6 : 0.35}
      stroke={link.color}
      strokeOpacity={hovered ? 0.9 : 0.6}
      strokeWidth={0.5}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
    />
  )
}

function SankeyTab({ talkers, onDrillDown }: { talkers: TopTalker[]; onDrillDown: (t: TopTalker) => void }) {
  const [selectedFlow, setSelectedFlow] = useState<TopTalker | null>(null)

  if (!talkers.length) {
    return <div className="text-center py-16 text-white">No flow data available</div>
  }

  const W = 860
  const H = 520

  let layout
  try {
    layout = buildSankeyLayout(talkers, W, H)
  } catch {
    return <div className="text-center py-16 text-red-400">Error building Sankey layout</div>
  }

  const { srcNodes, portNodes, dstNodes, links1, links2, COL_W } = layout

  const NodeGroup = ({ nodes }: { nodes: SankeyNode[] }) => (
    <g>
      {nodes.map(n => (
        <g key={n.key}>
          <rect x={n.x} y={n.y} width={COL_W} height={n.h}
            rx={3} fill="#3b82f6" fillOpacity={0.8} />
          <text
            x={n.x + COL_W / 2} y={n.y + n.h / 2}
            textAnchor="middle" dominantBaseline="middle"
            fontSize={9} fill="white" fontFamily="monospace"
          >
            {n.key.length > 14 ? n.key.slice(0, 13) + '…' : n.key}
          </text>
        </g>
      ))}
    </g>
  )

  return (
    <div>
      {/* Drill-down panel */}
      {selectedFlow && (
        <div className="mb-4 p-3 bg-gray-800 border border-blue-500/50 rounded-xl flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-sm flex-wrap flex-1 min-w-0">
            <span className="font-mono text-blue-300">{selectedFlow.src_ip}</span>
            <span className="text-white">→</span>
            <span className="bg-gray-700 text-white px-2 py-0.5 rounded text-xs font-mono">
              {protoLabel(selectedFlow.protocol)}:{selectedFlow.dst_port}
            </span>
            <span className="text-white">→</span>
            <span className="font-mono text-purple-300">{selectedFlow.dst_ip}</span>
            <span className="text-white text-xs ml-2">{fmtBytes(selectedFlow.bytes)} · {selectedFlow.flow_count.toLocaleString()} flows</span>
          </div>
          <button
            onClick={() => { onDrillDown(selectedFlow); setSelectedFlow(null) }}
            className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
          >
            View in Top Talkers ↗
          </button>
          <button
            onClick={() => setSelectedFlow(null)}
            className="text-white hover:text-white text-sm px-1"
          >
            ✕
          </button>
        </div>
      )}

      {(() => {
        const usedColors = new Set([...links1, ...links2].map(l => l.color))
        const legendItems = [
          ...SANKEY_PORT_GROUPS.filter(g => usedColors.has(g.color)),
          ...(usedColors.has(SANKEY_UDP_COLOR)   ? [{ label: 'UDP',   color: SANKEY_UDP_COLOR }]   : []),
          ...(usedColors.has(SANKEY_OTHER_COLOR) ? [{ label: 'Other', color: SANKEY_OTHER_COLOR }] : []),
        ]
        return (
          <div className="flex items-center gap-4 mb-3 text-xs text-white flex-wrap">
            <span className="font-medium text-white">src IP → dst port → dst IP · band width = bytes · click a band to drill down</span>
            {legendItems.map(({ label, color }) => (
              <span key={label} className="flex items-center gap-1">
                <span className="w-3 h-2 rounded-sm" style={{ background: color }} />
                <span>{label}</span>
              </span>
            ))}
          </div>
        )
      })()}

      <div className="overflow-x-auto">
        <svg width="100%" viewBox={`0 0 ${W} ${H + 24}`} xmlns="http://www.w3.org/2000/svg">
          <text x={COL_W / 2} y={12} textAnchor="middle" fontSize={10} fill="#9ca3af">Source IP</text>
          <text x={W / 2} y={12} textAnchor="middle" fontSize={10} fill="#9ca3af">Dst Port</text>
          <text x={W - COL_W / 2} y={12} textAnchor="middle" fontSize={10} fill="#9ca3af">Dest IP</text>

          <g transform="translate(0,20)">
            {links1.map((l, i) => (
              <SankeyBand key={i} link={l}
                onClick={l.flow ? () => setSelectedFlow(l.flow!) : undefined} />
            ))}
            {links2.map((l, i) => (
              <SankeyBand key={i} link={l}
                onClick={l.flow ? () => setSelectedFlow(l.flow!) : undefined} />
            ))}
            <NodeGroup nodes={srcNodes} />
            <NodeGroup nodes={portNodes} />
            <NodeGroup nodes={dstNodes} />
          </g>
        </svg>
      </div>
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
  const [activeTab, setActiveTab] = useState<'chart' | 'sankey' | 'talkers' | 'ports'>('chart')
  const [drillTarget, setDrillTarget] = useState<string | null>(null)

  const handleSankeyDrill = useCallback((t: TopTalker) => {
    setDrillTarget(`${t.src_ip}-${t.dst_ip}-${t.dst_port}-${t.protocol}`)
    setActiveTab('talkers')
  }, [])

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

  const device     = devices.find(d => d.sampler_ip === selected)
  const totalBytes = talkers.reduce((s, t) => s + t.bytes, 0)
  const windowSec  = WINDOW_SECS[window]
  const chartData  = series.map(p => ({
    ts: fmtTs(p.timestamp, window),
    bytes: p.bytes,
    packets: p.packets,
    flows: p.flow_count,
  }))
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
          <div className="flex items-center gap-3 text-sm text-white">
            <span className="font-mono text-white">{device.sampler_ip}</span>
            <span>·</span>
            <span>{fmtBytes(device.bytes_last_hour)}/hr</span>
            <span>·</span>
            <span className="text-white font-medium">{fmtBps(device.bytes_last_hour, 3600)} avg</span>
            <span>·</span>
          </div>
        )}

        <div className="ml-auto flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg p-1">
          {WINDOWS.map(w => (
            <button
              key={w}
              onClick={() => setWindow(w)}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors
                ${window === w ? 'bg-blue-600 text-white' : 'text-white hover:text-white'}`}
            >
              {w}
            </button>
          ))}
        </div>

        <button
          onClick={load}
          disabled={loading}
          className="text-white hover:text-white border border-gray-700 rounded-lg px-3 py-1.5 text-sm transition-colors disabled:opacity-50"
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
            <p className="text-xs text-white mb-1">{stat.label}</p>
            <p className="text-lg font-semibold text-white">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Tabs panel */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="flex border-b border-gray-800">
          {(['chart', 'sankey', 'talkers', 'ports'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-5 py-3 text-sm font-medium transition-colors
                ${activeTab === tab
                  ? 'text-blue-400 border-b-2 border-blue-500 -mb-px'
                  : 'text-white hover:text-white'}`}
            >
              {tab === 'chart' ? 'Traffic Chart' : tab === 'sankey' ? 'Flow Map' : tab === 'talkers' ? 'Top Talkers' : 'Ports'}
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
                <p className="text-xs text-white mb-3">Bytes per bucket</p>
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
                <p className="text-xs text-white mb-3">Packets per bucket</p>
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
            <TopTalkersTable talkers={talkers} totalBytes={totalBytes} window={window}
              externalExpanded={drillTarget} onExternalExpandedConsumed={() => setDrillTarget(null)} />
          )}

          {activeTab === 'ports' && (
            <PortsTabContent sampler_ip={selected} window={window} />
          )}

          {activeTab === 'sankey' && (
            <SankeyTab talkers={talkers} onDrillDown={handleSankeyDrill} />
          )}
        </div>
      </div>
    </div>
  )
}
