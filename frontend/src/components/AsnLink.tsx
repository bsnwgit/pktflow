import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Radio } from 'lucide-react'
import { api, AsnInfoResult } from '../api/client'

function AsnInfoModal({ asn, onClose }: { asn: string; onClose: () => void }) {
  const navigate = useNavigate()
  const [data, setData]       = useState<AsnInfoResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  useEffect(() => {
    setLoading(true)
    setError('')
    api.getAsnInfo(asn)
      .then(setData)
      .catch(e => setError(e.message ?? 'Lookup failed'))
      .finally(() => setLoading(false))
  }, [asn])

  const goToApiKeys = () => { onClose(); navigate('/settings?tab=apikeys') }

  const Row = ({ label, value }: { label: string; value?: string | number | null }) => (
    value === undefined || value === null || value === '' ? null : (
      <div className="flex justify-between items-start py-1.5 border-b border-gray-800 last:border-0">
        <span className="text-xs text-white shrink-0 w-32">{label}</span>
        <span className="text-sm text-white text-right break-all">{value}</span>
      </div>
    )
  )

  const info = data?.ipinfo

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div>
            <h2 className="font-semibold text-white">ASN Lookup</h2>
            <p className="text-xs font-mono text-blue-300 mt-0.5">{asn}</p>
          </div>
          <button onClick={onClose} className="text-white hover:text-white text-lg leading-none">✕</button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {loading && <p className="text-sm text-white">Looking up…</p>}
          {error && <p className="text-sm text-red-400">{error}</p>}

          {data?.ipinfo_error && (
            <p className="text-xs text-white">
              {data.ipinfo_error}
              {data.ipinfo_error.includes('Settings') && (
                <button onClick={goToApiKeys} className="ml-1 text-blue-400 hover:text-blue-300 underline">
                  Go to API Keys →
                </button>
              )}
            </p>
          )}

          {info && (
            <div>
              <Row label="Name" value={info.name} />
              <Row label="Country" value={info.country} />
              <Row label="Allocated" value={info.allocated} />
              <Row label="Registry" value={info.registry} />
              <Row label="Domain" value={info.domain} />
              <Row label="Num IPs" value={info.num_ips} />
              <Row label="IPv4 Blocks" value={info.prefixes?.length} />
              <Row label="IPv6 Blocks" value={info.prefixes6?.length} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function AsnLink({ asn, className = '' }: { asn: string; className?: string }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={e => { e.stopPropagation(); setOpen(true) }}
        className={`${className} group inline-flex items-center gap-1 rounded px-1 -mx-1 hover:bg-blue-500/10 transition-colors`}
        title="Look up ASN details"
      >
        <span className="underline decoration-blue-400/70 decoration-2 underline-offset-2 group-hover:decoration-blue-300">{asn}</span>
        <Radio className="w-3 h-3 text-blue-400 group-hover:text-blue-300 shrink-0" />
      </button>
      {open && <AsnInfoModal asn={asn} onClose={() => setOpen(false)} />}
    </>
  )
}
