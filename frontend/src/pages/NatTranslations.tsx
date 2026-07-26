/**
 * NAT Translations — table of observed (original address -> NAT'd address)
 * mappings, aggregated from flows carrying NAT Information Elements.
 *
 * Only populated when a NAT-capable exporter (Cisco ASA/ISR NSEL, Juniper
 * SRX, pfSense/OPNsense, etc.) sends NAT event fields via the direct UDP
 * NetFlow v9/IPFIX listener — most consumer/prosumer NAT gear doesn't
 * export these at all, so an empty table here is expected on many setups,
 * not a bug. See app/ingest/udp_listener.py and clickhouse/schema.sql.
 */
import { useEffect, useState } from 'react'
import { api, NatTranslation, DeviceSummary } from '../api/client'
import HelpButton from '../components/HelpButton'

function fmtBytes(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB'
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB'
  return b + ' B'
}

const WINDOWS = ['1h', '6h', '24h', '7d', '30d']

const DIRECTION_LABEL: Record<string, string> = {
  src: 'Source (egress)',
  dst: 'Destination (inbound)',
}

export default function NatTranslations() {
  const [data, setData] = useState<NatTranslation[]>([])
  const [loading, setLoading] = useState(true)
  const [window_, setWindow] = useState('24h')
  const [samplerFilter, setSamplerFilter] = useState('')
  const [search, setSearch] = useState('')
  const [samplers, setSamplers] = useState<DeviceSummary[]>([])

  useEffect(() => {
    api.getDeviceSummaries().then(setSamplers).catch(() => {})
  }, [])

  useEffect(() => {
    setLoading(true)
    const params: any = { window: window_, limit: '1000' }
    if (samplerFilter) params.sampler_ip = samplerFilter
    api.getNatTranslations(params).then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [window_, samplerFilter])

  const filtered = data.filter(d => {
    if (!search) return true
    const s = search.toLowerCase()
    return d.original_ip.toLowerCase().includes(s) || d.translated_ip.toLowerCase().includes(s)
      || d.sampler_name.toLowerCase().includes(s)
  })

  return (
    <div className="flex flex-col gap-4 min-h-0">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 mr-1">
          <h1 className="text-lg font-semibold text-white">NAT Translations</h1>
          <HelpButton title="NAT Translations — How It Works">
            <p>Shows original-address → NAT'd-address mappings observed in flow telemetry — e.g. a VLAN or subnet egressing through a different public IP than the rest of your network, even via the same physical WAN interface.</p>
            <p>This requires the exporting device itself to send standard NAT Information Elements (IPFIX <code className="text-gray-400">postNATSourceIPv4Address</code>/<code className="text-gray-400">postNATDestinationIPv4Address</code>, or NetFlow v9's equivalent) via pktFlow's <span className="text-gray-300 font-medium">direct UDP listener</span> — the goflow2/Vector HTTP ingestion path cannot carry these fields at all.</p>
            <p>Most consumer/prosumer routers (including most UniFi/EdgeOS gear) do not export NAT event data — this is a Cisco ASA/ISR (NSEL), Juniper SRX, or pfSense/OPNsense-class capability. An empty table here means no connected exporter has sent this data, not that nothing is being NATted.</p>
          </HelpButton>
        </div>
        <div className="flex gap-1">
          {WINDOWS.map(w => (
            <button key={w} onClick={() => setWindow(w)}
              className={`text-xs px-2.5 py-1 rounded-lg transition-colors ${window_ === w ? 'bg-blue-600 text-white' : 'bg-gray-800 text-white hover:bg-gray-700'}`}>
              {w}
            </button>
          ))}
        </div>
        <select
          value={samplerFilter}
          onChange={e => setSamplerFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-white text-xs rounded-lg px-2 py-1 focus:outline-none focus:border-blue-500"
        >
          <option value="">All samplers</option>
          {samplers.map(s => (
            <option key={s.sampler_ip} value={s.sampler_ip}>{s.sampler_name || s.sampler_ip}</option>
          ))}
        </select>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter by IP or sampler…"
          className="bg-gray-800 border border-gray-700 text-white text-xs rounded-lg px-3 py-1.5 w-64 focus:outline-none focus:border-blue-500 placeholder:text-white"
        />
        <span className="text-xs text-white">{filtered.length} mapping{filtered.length === 1 ? '' : 's'}</span>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 bg-gray-900">
              <th className="px-4 py-2.5 text-left text-xs text-white">Sampler</th>
              <th className="px-4 py-2.5 text-left text-xs text-white">Direction</th>
              <th className="px-4 py-2.5 text-left text-xs text-white">Original Address</th>
              <th className="px-4 py-2.5 text-left text-xs text-white">NAT'd Address</th>
              <th className="px-4 py-2.5 text-left text-xs text-white">Bytes</th>
              <th className="px-4 py-2.5 text-left text-xs text-white">Flows</th>
              <th className="px-4 py-2.5 text-left text-xs text-white">Last Seen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/50 bg-gray-900">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-white text-sm">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-white text-sm italic">
                No NAT translations observed — either nothing has NATted traffic in this window, or no connected exporter sends NAT event fields (see the help button above).
              </td></tr>
            ) : filtered.map((row, i) => (
              <tr key={i} className="hover:bg-gray-800/40 transition-colors">
                <td className="px-4 py-2 text-white">{row.sampler_name || row.sampler_ip}</td>
                <td className="px-4 py-2 text-white">{DIRECTION_LABEL[row.direction] || row.direction}</td>
                <td className="px-4 py-2 font-mono text-blue-300">{row.original_ip}</td>
                <td className="px-4 py-2 font-mono text-purple-300">{row.translated_ip}</td>
                <td className="px-4 py-2 text-white">{fmtBytes(row.bytes)}</td>
                <td className="px-4 py-2 text-white">{row.flow_count.toLocaleString()}</td>
                <td className="px-4 py-2 text-white text-xs">{new Date(row.last_seen).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
