import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Network } from 'lucide-react'
import { api, IpInfoResult, InternalIpInfoResult } from '../api/client'
import { isPrivateIp, isValidIpv4 } from '../utils/ip'

// ── Modal ─────────────────────────────────────────────────────────────────────
function IpInfoModal({ ip, onClose }: { ip: string; onClose: () => void }) {
  const navigate = useNavigate()
  const [data, setData]       = useState<IpInfoResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  useEffect(() => {
    setLoading(true)
    setError('')
    api.getIpInfo(ip)
      .then(setData)
      .catch(e => setError(e.message ?? 'Lookup failed'))
      .finally(() => setLoading(false))
  }, [ip])

  const goToApiKeys = () => { onClose(); navigate('/settings?tab=apikeys') }

  const score = data?.abuseipdb?.abuseConfidenceScore as number | undefined
  const scoreColor = score === undefined ? '' : score >= 50 ? 'text-red-400' : score >= 20 ? 'text-yellow-400' : 'text-green-400'

  const Row = ({ label, value }: { label: string; value?: string | number | null }) => (
    value === undefined || value === null || value === '' ? null : (
      <div className="flex justify-between items-start py-1.5 border-b border-gray-800 last:border-0">
        <span className="text-xs text-white shrink-0 w-32">{label}</span>
        <span className="text-sm text-white text-right break-all">{value}</span>
      </div>
    )
  )

  const ProviderError = ({ msg }: { msg: string }) => (
    <div className="text-xs text-white py-2">
      {msg}
      {msg.includes('Settings') && (
        <button onClick={goToApiKeys} className="ml-1 text-blue-400 hover:text-blue-300 underline">
          Go to API Keys →
        </button>
      )}
    </div>
  )

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <h2 className="font-semibold text-white">IP Lookup</h2>
            <p className="text-xs font-mono text-blue-300 mt-0.5">{ip}</p>
          </div>
          <button onClick={onClose} className="text-white hover:text-white text-lg leading-none">✕</button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {loading && <p className="text-sm text-white">Looking up…</p>}
          {error && <p className="text-sm text-red-400">{error}</p>}

          {data && (
            <>
              <div>
                <p className="text-xs font-medium text-white uppercase tracking-wider mb-2">ipinfo.io</p>
                {data.ipinfo_error
                  ? <ProviderError msg={data.ipinfo_error} />
                  : (
                    <div>
                      <Row label="City" value={data.ipinfo?.city} />
                      <Row label="Region" value={data.ipinfo?.region} />
                      <Row label="Country" value={data.ipinfo?.country} />
                      <Row label="Org / ASN" value={data.ipinfo?.org} />
                      <Row label="Hostname" value={data.ipinfo?.hostname} />
                      <Row label="Timezone" value={data.ipinfo?.timezone} />
                    </div>
                  )}
              </div>

              <div>
                <p className="text-xs font-medium text-white uppercase tracking-wider mb-2">AbuseIPDB</p>
                {data.abuseipdb_error
                  ? <ProviderError msg={data.abuseipdb_error} />
                  : (
                    <div>
                      <div className="flex justify-between items-start py-1.5 border-b border-gray-800">
                        <span className="text-xs text-white shrink-0 w-32">Abuse Confidence</span>
                        <span className={`text-sm font-semibold text-right ${scoreColor}`}>{score ?? '—'}%</span>
                      </div>
                      <Row label="Total Reports" value={data.abuseipdb?.totalReports} />
                      <Row label="Country" value={data.abuseipdb?.countryCode} />
                      <Row label="ISP" value={data.abuseipdb?.isp} />
                      <Row label="Usage Type" value={data.abuseipdb?.usageType} />
                      <Row label="Domain" value={data.abuseipdb?.domain} />
                      <Row label="Last Reported" value={data.abuseipdb?.lastReportedAt} />
                    </div>
                  )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Internal (pktIPAM) modal ────────────────────────────────────────────────────
function InternalIpInfoModal({ ip, onClose }: { ip: string; onClose: () => void }) {
  const navigate = useNavigate()
  const [data, setData]       = useState<InternalIpInfoResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  useEffect(() => {
    setLoading(true)
    setError('')
    api.getInternalIpInfo(ip)
      .then(setData)
      .catch(e => setError(e.message ?? 'Lookup failed'))
      .finally(() => setLoading(false))
  }, [ip])

  const goToSettings = () => { onClose(); navigate('/settings?tab=security') }

  const Row = ({ label, value }: { label: string; value?: string | number | null }) => (
    value === undefined || value === null || value === '' ? null : (
      <div className="flex justify-between items-start py-1.5 border-b border-gray-800 last:border-0">
        <span className="text-xs text-white shrink-0 w-32">{label}</span>
        <span className="text-sm text-white text-right break-all">{value}</span>
      </div>
    )
  )

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-purple-800/60 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <h2 className="font-semibold text-white">pktIPAM Lookup</h2>
            <p className="text-xs font-mono text-purple-300 mt-0.5">{ip}</p>
          </div>
          <button onClick={onClose} className="text-white hover:text-white text-lg leading-none">✕</button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {loading && <p className="text-sm text-white">Looking up…</p>}
          {error && <p className="text-sm text-red-400">{error}</p>}

          {data && !data.configured && (
            <p className="text-xs text-white">
              {data.error}
              <button onClick={goToSettings} className="ml-1 text-purple-400 hover:text-purple-300 underline">
                Go to Settings →
              </button>
            </p>
          )}

          {data && data.configured && data.error && (
            <p className="text-xs text-red-400">{data.error}</p>
          )}

          {data && data.configured && !data.error && !data.found && (
            <p className="text-xs text-white">No record of {ip} in pktIPAM.</p>
          )}

          {data && data.configured && !data.error && data.found && (
            <>
              <div>
                <p className="text-xs font-medium text-white uppercase tracking-wider mb-2">Inventory</p>
                <Row label="Subnet" value={data.subnet?.cidr} />
                <Row label="Site" value={data.subnet?.site} />
                <Row label="Status" value={data.ip_address?.status} />
                <Row label="Hostname" value={data.ip_address?.hostname} />
                <Row label="MAC Address" value={data.ip_address?.mac_address} />
                <Row label="Owner" value={data.ip_address?.owner} />
                <Row label="Description" value={data.ip_address?.description} />
              </div>

              {data.dhcp_leases.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-white uppercase tracking-wider mb-2">DHCP Lease</p>
                  <Row label="State" value={data.dhcp_leases[0].state} />
                  <Row label="Hostname" value={data.dhcp_leases[0].hostname} />
                  <Row label="MAC Address" value={data.dhcp_leases[0].mac_address} />
                  <Row label="Ends" value={data.dhcp_leases[0].ends_at} />
                </div>
              )}

              {data.dns_records.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-white uppercase tracking-wider mb-2">DNS Records</p>
                  {data.dns_records.map((r, i) => (
                    <Row key={i} label={r.record_type} value={`${r.name}.${r.zone}`} />
                  ))}
                </div>
              )}

              {data.arp_entries.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-white uppercase tracking-wider mb-2">Last Seen (ARP)</p>
                  <Row label="Device" value={data.arp_entries[0].device_label} />
                  <Row label="Interface" value={data.arp_entries[0].interface} />
                  <Row label="VLAN" value={data.arp_entries[0].vlan_tag} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Link ──────────────────────────────────────────────────────────────────────
export default function IpLink({ ip, className = '' }: { ip: string; className?: string }) {
  const [open, setOpen] = useState(false)

  if (isPrivateIp(ip)) {
    if (!isValidIpv4(ip)) {
      return <span className={className}>{ip}</span>
    }
    return (
      <>
        <button
          onClick={e => { e.stopPropagation(); setOpen(true) }}
          className={`${className} group inline-flex items-center gap-1 rounded px-1 -mx-1 hover:bg-purple-500/10 transition-colors`}
          title="Look up in pktIPAM"
        >
          <span className="underline decoration-purple-400/70 decoration-2 underline-offset-2 decoration-dashed group-hover:decoration-purple-300">{ip}</span>
          <Network className="w-3 h-3 text-purple-400 group-hover:text-purple-300 shrink-0" />
        </button>
        {open && <InternalIpInfoModal ip={ip} onClose={() => setOpen(false)} />}
      </>
    )
  }

  return (
    <>
      <button
        onClick={e => { e.stopPropagation(); setOpen(true) }}
        className={`${className} group inline-flex items-center gap-1 rounded px-1 -mx-1 hover:bg-blue-500/10 transition-colors`}
        title="Look up IP details"
      >
        <span className="underline decoration-blue-400/70 decoration-2 underline-offset-2 group-hover:decoration-blue-300">{ip}</span>
        <Search className="w-3 h-3 text-blue-400 group-hover:text-blue-300 shrink-0" />
      </button>
      {open && <IpInfoModal ip={ip} onClose={() => setOpen(false)} />}
    </>
  )
}

// ── Linkify ───────────────────────────────────────────────────────────────────
// Splits free-text (e.g. a backend-generated alert message like "Unknown
// sampler 10.0.0.5 sent NetFlow data") on embedded IPv4 addresses and wraps
// each one in an IpLink, leaving the surrounding text as plain string
// fragments — for messages where the IP isn't in its own dedicated field.
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g

export function linkifyIps(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = []
  let lastIndex = 0
  let i = 0
  for (const match of text.matchAll(IPV4_RE)) {
    const index = match.index ?? 0
    if (index > lastIndex) parts.push(text.slice(lastIndex, index))
    parts.push(<IpLink key={`ip-${i++}`} ip={match[0]} />)
    lastIndex = index + match[0].length
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return parts
}
