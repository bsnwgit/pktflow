import { useEffect, useState, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, downloadExport, FlowRecord, DeviceSummary } from '../api/client'
import { protoLabel } from '../utils/protocols'

// ── Helpers ───────────────────────────────────────────────────────────────────

const TCP_FLAGS: Array<[number, string, string]> = [
  [0x01, 'FIN', 'text-white'],
  [0x02, 'SYN', 'text-green-400'],
  [0x04, 'RST', 'text-red-400'],
  [0x08, 'PSH', 'text-yellow-400'],
  [0x10, 'ACK', 'text-blue-400'],
  [0x20, 'URG', 'text-purple-400'],
]

function fmtBytes(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB'
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB'
  return b + ' B'
}

function fmtDuration(ms: number): string {
  if (ms === 0) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function fmtTime(ts: string): string {
  return new Date(ts).toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function fmtAbsTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// ── Flow Detail Panel ─────────────────────────────────────────────────────────
function FlowDetail({ flow, onClose, onExploreIp }: {
  flow: FlowRecord
  onClose: () => void
  onExploreIp: (ip: string) => void
}) {
  const flags = TCP_FLAGS.filter(([bit]) => (flow.protocol === 6) && ((flow as any).tcp_flags ?? 0) & bit)

  const Field = ({ label, value, mono = false, children }: {
    label: string; value?: string | number; mono?: boolean; children?: React.ReactNode
  }) => (
    <div className="flex justify-between items-start py-2 border-b border-gray-800 last:border-0">
      <span className="text-xs text-white shrink-0 w-36">{label}</span>
      {children ?? (
        <span className={`text-sm text-white text-right ${mono ? 'font-mono' : ''}`}>{value ?? '—'}</span>
      )}
    </div>
  )

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <h2 className="font-semibold text-white">Flow Detail</h2>
            <p className="text-xs text-white mt-0.5">{fmtTime(flow.timestamp)}</p>
          </div>
          <button onClick={onClose} className="text-white hover:text-white text-lg leading-none">✕</button>
        </div>

        <div className="px-5 py-4 space-y-1">
          {/* Collector */}
          <p className="text-xs font-medium text-white uppercase tracking-wider mb-2">Collector</p>
          <Field label="Sampler" value={`${flow.sampler_name || flow.sampler_ip}`} />
          <Field label="Sampler IP" value={flow.sampler_ip} mono />

          {/* Network */}
          <p className="text-xs font-medium text-white uppercase tracking-wider mt-4 mb-2">Network</p>
          <Field label="Source IP">
            <div className="flex items-center gap-2">
              <span className="font-mono text-blue-300 text-sm">{flow.src_ip}</span>
              <button
                onClick={() => onExploreIp(flow.src_ip)}
                className="text-xs text-white hover:text-blue-400 transition-colors"
                title="Explore all flows from this IP"
              >
                filter ↗
              </button>
            </div>
          </Field>
          <Field label="Source Port" value={flow.src_port || '—'} />
          <Field label="Destination IP">
            <div className="flex items-center gap-2">
              <span className="font-mono text-purple-300 text-sm">{flow.dst_ip}</span>
              <button
                onClick={() => onExploreIp(flow.dst_ip)}
                className="text-xs text-white hover:text-blue-400 transition-colors"
                title="Explore all flows to this IP"
              >
                filter ↗
              </button>
            </div>
          </Field>
          <Field label="Destination Port" value={flow.dst_port} />
          <Field label="Protocol">
            <span className="bg-gray-800 text-gray-200 text-xs px-2 py-0.5 rounded font-mono">
              {protoLabel(flow.protocol)} ({flow.protocol})
            </span>
          </Field>

          {/* Volume */}
          <p className="text-xs font-medium text-white uppercase tracking-wider mt-4 mb-2">Volume</p>
          <Field label="Bytes" value={`${fmtBytes(flow.bytes)} (${flow.bytes.toLocaleString()} B)`} />
          <Field label="Packets" value={flow.packets.toLocaleString()} />
          <Field label="Duration" value={fmtDuration(flow.duration_ms)} />
          {flow.duration_ms > 0 && flow.bytes > 0 && (
            <Field
              label="Avg Throughput"
              value={`${fmtBytes(Math.round((flow.bytes * 8 * 1000) / flow.duration_ms))}/s`}
            />
          )}

          {/* TCP Flags (only for TCP) */}
          {flow.protocol === 6 && (
            <>
              <p className="text-xs font-medium text-white uppercase tracking-wider mt-4 mb-2">TCP Flags</p>
              <div className="flex gap-2 py-2">
                {TCP_FLAGS.map(([bit, name, cls]) => (
                  <span
                    key={name}
                    className={`text-xs px-2 py-0.5 rounded font-mono border
                      ${((flow as any).tcp_flags ?? 0) & bit
                        ? `${cls} border-current bg-current/10`
                        : 'text-white border-gray-800'}`}
                  >
                    {name}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Actions */}
        <div className="px-5 py-4 border-t border-gray-800 flex gap-3">
          <button
            onClick={() => onExploreIp(flow.src_ip)}
            className="flex-1 bg-gray-800 hover:bg-gray-700 text-white text-sm rounded-lg py-2 transition-colors"
          >
            All flows from {flow.src_ip}
          </button>
          <button
            onClick={() => { onExploreIp(flow.dst_ip) }}
            className="flex-1 bg-gray-800 hover:bg-gray-700 text-white text-sm rounded-lg py-2 transition-colors"
          >
            All flows to {flow.dst_ip}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Filter bar ────────────────────────────────────────────────────────────────
interface Filters {
  src_ip: string; dst_ip: string
  src_port: string; dst_port: string
  protocol: string; sampler_ip: string
  window: string
}

const EMPTY_FILTERS: Filters = {
  src_ip: '', dst_ip: '', src_port: '', dst_port: '',
  protocol: '', sampler_ip: '', window: '1h',
}

const WINDOWS = ['15m', '1h', '6h', '24h', '7d'] as const

// ── Main page ─────────────────────────────────────────────────────────────────
export default function FlowExplorer() {
  const [searchParams, setSearchParams] = useSearchParams()

  const [filters, setFilters] = useState<Filters>({
    ...EMPTY_FILTERS,
    src_ip:     searchParams.get('src_ip')   ?? '',
    dst_ip:     searchParams.get('dst_ip')   ?? '',
    dst_port:   searchParams.get('dst_port') ?? '',
    protocol:   searchParams.get('protocol') ?? '',
    sampler_ip: searchParams.get('sampler')  ?? '',
    window:     searchParams.get('window')   ?? '1h',
  })

  // Absolute time range — populated when navigating from an alert "Investigate" link
  const [timeFrom, setTimeFrom] = useState<string>(searchParams.get('time_from') ?? '')
  const [timeTo,   setTimeTo]   = useState<string>(searchParams.get('time_to')   ?? '')

  const [devices, setDevices]     = useState<DeviceSummary[]>([])
  const [flows, setFlows]         = useState<FlowRecord[]>([])
  const [loading, setLoading]     = useState(false)
  const [offset, setOffset]       = useState(0)
  const [selected, setSelected]   = useState<FlowRecord | null>(null)
  const [exportMsg, setExportMsg] = useState('')

  const [tableFilter, setTableFilter]     = useState('')
  const [tableSortKey, setTableSortKey]   = useState<keyof FlowRecord | null>(null)
  const [tableSortDir, setTableSortDir]   = useState<'asc' | 'desc'>('desc')

  // Conversation mode — set when user clicks "Show Conversation" on a flow row
  const [convId, setConvId]   = useState<number | null>(null)
  const [convFlows, setConvFlows] = useState<FlowRecord[]>([])

  const PAGE_SIZE = 100

  const FLOW_COLS: Array<{ label: string; key: keyof FlowRecord | null }> = [
    { label: 'Time',        key: 'timestamp' },
    { label: 'Sampler',     key: 'sampler_name' },
    { label: 'Source',      key: 'src_ip' },
    { label: 'Destination', key: 'dst_ip' },
    { label: 'Proto',       key: 'protocol' },
    { label: 'Port',        key: 'dst_port' },
    { label: 'Bytes',       key: 'bytes' },
    { label: 'Pkts',        key: 'packets' },
    { label: 'Duration',    key: 'duration_ms' },
    { label: 'Conv',        key: null },
  ]

  const toggleTableSort = (key: keyof FlowRecord) => {
    if (tableSortKey === key) setTableSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setTableSortKey(key); setTableSortDir('desc') }
  }

  const displayedFlows = useMemo(() => {
    let result = flows
    if (tableFilter.trim()) {
      const q = tableFilter.toLowerCase()
      result = result.filter(f =>
        f.src_ip.includes(q) || f.dst_ip.includes(q) ||
        String(f.dst_port).includes(q) || String(f.src_port).includes(q) ||
        protoLabel(f.protocol).toLowerCase().includes(q) ||
        (f.sampler_name || f.sampler_ip).toLowerCase().includes(q)
      )
    }
    if (tableSortKey) {
      result = [...result].sort((a, b) => {
        const av = a[tableSortKey] as any
        const bv = b[tableSortKey] as any
        if (typeof av === 'number' && typeof bv === 'number')
          return tableSortDir === 'asc' ? av - bv : bv - av
        return tableSortDir === 'asc'
          ? String(av ?? '').localeCompare(String(bv ?? ''))
          : String(bv ?? '').localeCompare(String(av ?? ''))
      })
    }
    return result
  }, [flows, tableFilter, tableSortKey, tableSortDir])

  useEffect(() => {
    api.getDeviceSummaries().then(setDevices)
  }, [])

  const showConversation = async (flow: FlowRecord) => {
    if (!flow.conversation_id || flow.conversation_id === 0) return
    setConvId(flow.conversation_id)
    setLoading(true)
    try {
      const results = await api.getConversation(flow.conversation_id, 120)
      setConvFlows(results)
    } catch (e) {
      console.error('conversation fetch failed', e)
      setConvFlows([])
    } finally {
      setLoading(false)
    }
  }

  const clearConversation = () => { setConvId(null); setConvFlows([]) }

  const search = async (off = 0) => {
    setLoading(true)
    setOffset(off)
    try {
      const params: any = { limit: String(PAGE_SIZE), offset: String(off) }
      if (filters.src_ip)     params.src_ip     = filters.src_ip
      if (filters.dst_ip)     params.dst_ip     = filters.dst_ip
      if (filters.src_port)   params.src_port   = filters.src_port
      if (filters.dst_port)   params.dst_port   = filters.dst_port
      if (filters.protocol)   params.protocol   = filters.protocol
      if (filters.sampler_ip) params.sampler_ip = filters.sampler_ip
      // Absolute range (from alert drill-down) takes priority over relative window.
      // Replace Z suffix with +00:00 — Python 3.9 fromisoformat() rejects Z.
      if (timeFrom && timeTo) {
        params.start = timeFrom.replace('Z', '+00:00')
        params.end   = timeTo.replace('Z', '+00:00')
      } else {
        if (filters.window) params.window = filters.window
      }
      const results = await api.searchFlows(params)
      setFlows(off === 0 ? results : [...flows, ...results])
    } finally {
      setLoading(false)
    }
  }

  // Auto-search on mount if URL params were passed (drill-in from Alert / Device View / Port Inventory)
  useEffect(() => {
    if (filters.src_ip || filters.dst_ip || filters.sampler_ip || filters.dst_port || timeFrom) search(0)
  }, [])

  const handleExploreIp = (ip: string) => {
    setSelected(null)
    setFilters(f => ({ ...f, src_ip: ip, dst_ip: '' }))
  }

  const handleExport = async (format: 'csv' | 'json' | 'pcap') => {
    const params: Record<string, string> = {}
    if (filters.src_ip)     params.src_ip     = filters.src_ip
    if (filters.dst_ip)     params.dst_ip     = filters.dst_ip
    if (filters.src_port)   params.src_port   = filters.src_port
    if (filters.dst_port)   params.dst_port   = filters.dst_port
    if (filters.protocol)   params.protocol   = filters.protocol
    if (filters.sampler_ip) params.sampler_ip = filters.sampler_ip
    if (timeFrom && timeTo) {
      params.start = timeFrom.replace('Z', '+00:00')
      params.end   = timeTo.replace('Z', '+00:00')
    } else {
      if (filters.window) params.window = filters.window
    }

    const ext = format === 'pcap' ? 'pcap' : format
    const err = await downloadExport(`/flows/export/${format}`, params, `pktflow-flows.${ext}`)
    if (err) { setExportMsg(err); return }
    setExportMsg(`Exported as ${format.toUpperCase()}`)
    setTimeout(() => setExportMsg(''), 3000)
  }

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setFilters(f => ({ ...f, [k]: e.target.value }))

  return (
    <div className="space-y-4">
      {selected && (
        <FlowDetail
          flow={selected}
          onClose={() => setSelected(null)}
          onExploreIp={handleExploreIp}
        />
      )}

      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Flow Explorer</h1>
          <p className="text-sm text-white mt-0.5">Search and inspect individual flow records</p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {[
            { key: 'src_ip',   label: 'Source IP',  placeholder: '192.168.1.1' },
            { key: 'dst_ip',   label: 'Dest IP',    placeholder: '10.0.0.1' },
            { key: 'src_port', label: 'Src Port',   placeholder: '443' },
            { key: 'dst_port', label: 'Dst Port',   placeholder: '443' },
            { key: 'protocol', label: 'Protocol',   placeholder: '6' },
          ].map(({ key, label, placeholder }) => (
            <div key={key}>
              <label className="block text-xs text-white mb-1">{label}</label>
              <input
                value={(filters as any)[key]}
                onChange={set(key as keyof Filters)}
                placeholder={placeholder}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                onKeyDown={e => e.key === 'Enter' && search(0)}
              />
            </div>
          ))}

          {/* Sampler selector */}
          <div>
            <label className="block text-xs text-white mb-1">Sampler</label>
            <select
              value={filters.sampler_ip}
              onChange={set('sampler_ip')}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">All</option>
              {devices.map(d => (
                <option key={d.sampler_ip} value={d.sampler_ip}>
                  {d.sampler_name || d.sampler_ip}
                </option>
              ))}
            </select>
          </div>

          {/* Window / absolute alert range */}
          <div>
            <label className="block text-xs text-white mb-1">
              {timeFrom && timeTo ? 'Alert window' : 'Window'}
            </label>
            {timeFrom && timeTo ? (
              <div className="flex items-center gap-1 bg-gray-800 border border-blue-500/40 rounded-lg px-2.5 py-1.5 text-xs text-blue-300">
                <span className="truncate">{fmtAbsTime(timeFrom)} → {fmtAbsTime(timeTo)}</span>
                <button
                  onClick={() => { setTimeFrom(''); setTimeTo('') }}
                  className="shrink-0 text-gray-500 hover:text-white ml-1"
                  title="Clear fixed range and use relative window"
                >×</button>
              </div>
            ) : (
              <select
                value={filters.window}
                onChange={set('window')}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {['15m', '1h', '6h', '24h', '7d', '30d'].map(w => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 mt-3">
          <button
            onClick={() => search(0)}
            disabled={loading}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-5 py-2 transition-colors"
          >
            {loading ? 'Searching…' : 'Search'}
          </button>
          <button
            onClick={() => { setFilters(EMPTY_FILTERS); setFlows([]); setTimeFrom(''); setTimeTo('') }}
            className="text-white hover:text-white text-sm border border-gray-700 rounded-lg px-4 py-2 transition-colors"
          >
            Clear
          </button>

          {flows.length > 0 && (
            <div className="ml-auto flex items-center gap-2">
              {exportMsg && <span className="text-xs text-green-400">{exportMsg}</span>}
              <span className="text-xs text-white mr-1">Export:</span>
              {(['csv', 'json', 'pcap'] as const).map(fmt => (
                <button
                  key={fmt}
                  onClick={() => handleExport(fmt)}
                  className="text-xs border border-gray-700 hover:border-gray-500 text-white hover:text-white rounded px-2.5 py-1 transition-colors uppercase"
                >
                  {fmt}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Results */}
      {flows.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-3 flex-wrap">
            <input
              value={tableFilter}
              onChange={e => setTableFilter(e.target.value)}
              placeholder="Filter by IP, port, proto…"
              className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1 text-xs text-white placeholder-gray-600 w-44 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {tableFilter && <button onClick={() => setTableFilter('')} className="text-xs text-white hover:text-white">✕</button>}
            <p className="text-sm text-white ml-auto">
              <span className="text-white font-medium">{displayedFlows.length.toLocaleString()}</span>
              {displayedFlows.length !== flows.length && <span className="text-white"> of {flows.length.toLocaleString()}</span>}
              {' flows'}
              {flows.length === PAGE_SIZE && <span className="text-white"> (first page)</span>}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-800">
                  {FLOW_COLS.map(col => (
                    <th
                      key={col.label}
                      onClick={() => col.key && toggleTableSort(col.key)}
                      className={`px-3 py-3 text-left font-medium whitespace-nowrap select-none
                        ${col.key
                          ? `cursor-pointer ${tableSortKey === col.key ? 'text-blue-400' : 'text-white hover:text-gray-200'}`
                          : 'text-white'}`}
                    >
                      {col.label}
                      {tableSortKey === col.key && <span className="ml-1">{tableSortDir === 'asc' ? '↑' : '↓'}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {displayedFlows.map((f, i) => (
                  <tr
                    key={i}
                    onClick={() => setSelected(f)}
                    className="hover:bg-gray-800/50 cursor-pointer transition-colors group"
                  >
                    <td className="px-3 py-2 text-white whitespace-nowrap">{fmtTime(f.timestamp)}</td>
                    <td className="px-3 py-2 text-white">{f.sampler_name || f.sampler_ip}</td>
                    <td className="px-3 py-2 font-mono text-blue-300">{f.src_ip}</td>
                    <td className="px-3 py-2 font-mono text-purple-300">{f.dst_ip}</td>
                    <td className="px-3 py-2">
                      <span className="bg-gray-800 text-white px-1.5 py-0.5 rounded">
                        {protoLabel(f.protocol)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-white">{f.dst_port}</td>
                    <td className="px-3 py-2 text-white font-medium">{fmtBytes(f.bytes)}</td>
                    <td className="px-3 py-2 text-white">{f.packets.toLocaleString()}</td>
                    <td className="px-3 py-2 text-white">{fmtDuration(f.duration_ms)}</td>
                    <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                      {f.conversation_id && f.conversation_id !== 0 ? (
                        <button
                          onClick={() => showConversation(f)}
                          className="text-xs bg-gray-800 hover:bg-gray-700 text-cyan-400 hover:text-cyan-300 border border-cyan-500/30 rounded px-2 py-0.5 transition-colors whitespace-nowrap"
                          title="Show both legs of this conversation"
                        >
                          {f.flow_role === 1 ? '→ Convo' : f.flow_role === 2 ? '← Convo' : 'Convo'}
                        </button>
                      ) : (
                        <span className="text-gray-700 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Load more */}
          {flows.length % PAGE_SIZE === 0 && (
            <div className="px-4 py-3 border-t border-gray-800 text-center">
              <button
                onClick={() => search(offset + PAGE_SIZE)}
                disabled={loading}
                className="text-sm text-blue-400 hover:text-blue-300 disabled:opacity-50"
              >
                {loading ? 'Loading…' : 'Load next 100 flows'}
              </button>
            </div>
          )}
        </div>
      )}

      {!loading && flows.length === 0 && (
        <div className="flex flex-col items-center justify-center h-40 text-white">
          <p className="text-sm">Enter filters above and click Search</p>
        </div>
      )}

      {/* Conversation panel — slides in when a flow's Convo button is clicked */}
      {convId !== null && (
        <div className="bg-gray-900 border border-cyan-500/30 rounded-xl mt-4">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
            <div>
              <span className="text-cyan-400 font-semibold text-sm">Conversation</span>
              <span className="text-gray-500 text-xs ml-2 font-mono">id:{convId}</span>
              <span className="text-gray-500 text-xs ml-2">— both legs, last 2 hours</span>
            </div>
            <button onClick={clearConversation} className="text-gray-500 hover:text-white text-lg leading-none">×</button>
          </div>
          {loading ? (
            <div className="px-4 py-6 text-center text-gray-400 text-sm">Loading…</div>
          ) : convFlows.length === 0 ? (
            <div className="px-4 py-6 text-center text-gray-400 text-sm">
              No conversation data — this flow may pre-date conversation tracking.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-400">
                    <th className="px-3 py-2 text-left">Time</th>
                    <th className="px-3 py-2 text-left">Role</th>
                    <th className="px-3 py-2 text-left">Source</th>
                    <th className="px-3 py-2 text-left">Destination</th>
                    <th className="px-3 py-2 text-left">Proto</th>
                    <th className="px-3 py-2 text-left">Port</th>
                    <th className="px-3 py-2 text-left">Bytes</th>
                    <th className="px-3 py-2 text-left">Pkts</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {convFlows.map((f, i) => (
                    <tr key={i} onClick={() => setSelected(f)} className="hover:bg-gray-800/50 cursor-pointer">
                      <td className="px-3 py-2 text-white whitespace-nowrap">{fmtTime(f.timestamp)}</td>
                      <td className="px-3 py-2">
                        {f.flow_role === 1
                          ? <span className="text-green-400 font-semibold">→ Request</span>
                          : f.flow_role === 2
                          ? <span className="text-cyan-400 font-semibold">← Response</span>
                          : <span className="text-gray-500">—</span>}
                      </td>
                      <td className="px-3 py-2 font-mono text-blue-300">{f.src_ip}</td>
                      <td className="px-3 py-2 font-mono text-purple-300">{f.dst_ip}</td>
                      <td className="px-3 py-2 text-white">{protoLabel(f.protocol)}</td>
                      <td className="px-3 py-2 text-white">{f.dst_port}</td>
                      <td className="px-3 py-2 text-white font-medium">{fmtBytes(f.bytes)}</td>
                      <td className="px-3 py-2 text-white">{f.packets.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
