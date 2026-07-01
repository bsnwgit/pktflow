/**
 * GeoMap — IP geolocation traffic map
 *
 * Exports:
 *   GeoPage      → full nav page at /geo (includes VPN mappings panel)
 *   GeoMapCard   → inline card for the Analytics page
 *   default      → full-screen standalone pop-out at /geomap
 *
 * Arc line styles by type:
 *   gp  — GlobalProtect VPN  → green  (#10b981), dash-dash-dot
 *   s2s — Site-to-Site VPN   → blue   (#3b82f6), dashed
 *   wan — Regular WAN traffic → red    (#ef4444), solid
 *
 * Circle marker colours by group:
 *   medical → purple  (#a78bfa)
 *   dental  → green   (#34d399)
 *   other   → blue    (#60a5fa)
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import * as d3 from 'd3'
import { Maximize2, RefreshCw, X, MapPin, Network, Trash2, Plus } from 'lucide-react'
import { api, setToken, getToken, getTokenRole } from '../api/client'
import type { GeoDataResponse, VpnMapping, VpnMappingIn } from '../api/client'

// ── Arc type styles ────────────────────────────────────────────────────────
const ARC_STYLE: Record<string, { color: string; dash: string; label: string }> = {
  gp:  { color: '#10b981', dash: '8,3,8,3,2,3', label: 'GlobalProtect VPN' },
  s2s: { color: '#3b82f6', dash: '10,5',         label: 'Site-to-Site VPN'  },
  wan: { color: '#ef4444', dash: '',             label: 'WAN Traffic'       },
}

// ── Circle marker colours by group ────────────────────────────────────────
const GROUP_COLOR: Record<string, string> = {
  medical: '#a78bfa',
  dental:  '#34d399',
}
const GROUP_STROKE: Record<string, string> = {
  medical: '#c4b5fd',
  dental:  '#6ee7b7',
}
const DEFAULT_FILL   = '#ef4444'
const DEFAULT_STROKE = '#fca5a5'

// ── Formatters ─────────────────────────────────────────────────────────────
function fmt(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`
  return `${n} B`
}
function fmtNum(n: number) {
  return n >= 1_000 ? `${(n / 1000).toFixed(1)}K` : String(n)
}

// ── LeafletGeoMap — core map component ────────────────────────────────────
function LeafletGeoMap({ geoData }: { geoData: GeoDataResponse }) {
  const divRef    = useRef<HTMLDivElement>(null)
  const mapRef    = useRef<L.Map | null>(null)
  const markersRef = useRef<L.CircleMarker[]>([])

  // Initialise Leaflet once
  useEffect(() => {
    if (!divRef.current || mapRef.current) return

    const map = L.map(divRef.current, {
      center: [20, 0], zoom: 2,
      zoomControl: true, attributionControl: false,
    })

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 19,
    }).addTo(map)

    L.control.attribution({ position: 'bottomright', prefix: '' })
      .addAttribution('© <a href="https://osm.org" target="_blank">OSM</a> © <a href="https://carto.com" target="_blank">CARTO</a>')
      .addTo(map)

    // D3 arc overlay pane
    L.svg({ pane: 'overlayPane' }).addTo(map)

    // ── Static legend (Leaflet control) ──────────────────────────────────
    const legend = new L.Control({ position: 'bottomleft' })
    legend.onAdd = () => {
      const div = L.DomUtil.create('div')
      div.style.cssText = `
        background:rgba(17,24,39,0.88);border:1px solid #374151;border-radius:8px;
        padding:8px 11px;font-size:11px;line-height:1.7;color:#d1d5db;
        pointer-events:none;user-select:none;
      `
      div.innerHTML = `
        <div style="color:#9ca3af;font-weight:600;margin-bottom:3px;font-size:10px;text-transform:uppercase;letter-spacing:.05em">Traffic Type</div>
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:2px">
          <svg width="26" height="7"><line x1="0" y1="3.5" x2="26" y2="3.5" stroke="#10b981" stroke-width="2" stroke-dasharray="6,2,6,2,2,2"/></svg>
          GlobalProtect VPN
        </div>
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:2px">
          <svg width="26" height="7"><line x1="0" y1="3.5" x2="26" y2="3.5" stroke="#3b82f6" stroke-width="2" stroke-dasharray="8,4"/></svg>
          Site-to-Site VPN
        </div>
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:6px">
          <svg width="26" height="7"><line x1="0" y1="3.5" x2="26" y2="3.5" stroke="#ef4444" stroke-width="2"/></svg>
          WAN Traffic
        </div>
        <div style="color:#9ca3af;font-weight:600;margin-bottom:3px;font-size:10px;text-transform:uppercase;letter-spacing:.05em">Sites</div>
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:2px">
          <div style="width:10px;height:10px;border-radius:50%;background:#a78bfa;flex-shrink:0"></div>Medical
        </div>
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:2px">
          <div style="width:10px;height:10px;border-radius:50%;background:#34d399;flex-shrink:0"></div>Dental
        </div>
        <div style="display:flex;align-items:center;gap:7px">
          <div style="width:10px;height:10px;border-radius:50%;background:#ef4444;flex-shrink:0"></div>External
        </div>
      `
      return div
    }
    legend.addTo(map)

    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, [])

  // Draw / update whenever geoData changes
  useEffect(() => {
    const map = mapRef.current
    if (!map || !geoData) return

    // Clear previous markers
    markersRef.current.forEach(m => m.remove())
    markersRef.current = []

    // Clear previous arc layer
    d3.select(map.getPanes().overlayPane).select('svg').select('.geo-arcs').remove()

    if (!geoData.locations.length) return

    // Fit bounds to data
    const latlngs = geoData.locations.map(l => [l.lat, l.lng] as [number, number])
    if (latlngs.length === 1) {
      map.setView(latlngs[0], 5)
    } else {
      map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40], maxZoom: 8 })
    }

    // Circle size scale
    const maxBytes = Math.max(...geoData.locations.map(l => l.bytes), 1)
    const rScale   = d3.scaleSqrt().domain([0, maxBytes]).range([6, 24])

    // Draw location circles, coloured by group
    geoData.locations.forEach(loc => {
      const r      = rScale(loc.bytes)
      const fill   = GROUP_COLOR[loc.group ?? '']   ?? DEFAULT_FILL
      const stroke = GROUP_STROKE[loc.group ?? ''] ?? DEFAULT_STROKE

      const displayLabel = loc.site_name
        ? `${loc.site_name} <span style="color:#9ca3af;font-size:10px">(${loc.group})</span>`
        : `<span style="font-family:monospace;color:#93c5fd">${loc.ip}</span>`

      const locationLine = loc.site_name
        ? `via ${loc.ip}`
        : [loc.city, loc.country].filter(Boolean).join(', ')

      const m = L.circleMarker([loc.lat, loc.lng], {
        radius: r,
        fillColor: fill,
        fillOpacity: 0.75,
        color: stroke,
        weight: 1.5,
      })
        .bindTooltip(
          `<div style="background:#111827;border:1px solid #374151;border-radius:6px;padding:8px 10px;font-size:12px;line-height:1.6;color:#f9fafb">
            <div style="font-weight:600">${displayLabel}</div>
            <div style="color:#9ca3af">${locationLine}</div>
            <div>${fmt(loc.bytes)} · ${fmtNum(loc.flows)} flows</div>
            <div style="color:#6b7280;font-size:11px;margin-top:4px">Click to explore flows</div>
          </div>`,
          { direction: 'top', offset: L.point(0, -r - 4), className: 'pf-geo-tooltip', opacity: 1 }
        )
        .on('click', () => {
          window.open(`/explorer?src_ip=${loc.ip}`, '_blank', 'noopener')
        })
        .addTo(map)

      const el = m.getElement() as HTMLElement | undefined
      if (el) el.style.cursor = 'pointer'
      markersRef.current.push(m)
    })

    // ── D3 arc overlay ──────────────────────────────────────────────────
    const svg  = d3.select(map.getPanes().overlayPane).select('svg')
    const arcG = svg.append('g').attr('class', 'geo-arcs leaflet-zoom-hide')

    const maxArcBytes  = Math.max(...geoData.arcs.map(a => a.bytes), 1)
    const widthScale   = d3.scaleSqrt().domain([0, maxArcBytes]).range([0.8, 4])

    function drawArcs() {
      if (!mapRef.current) return
      arcG.selectAll('*').remove()

      const pathDs = geoData.arcs.map(arc => {
        const src = mapRef.current!.latLngToLayerPoint([arc.src_lat, arc.src_lng])
        const dst = mapRef.current!.latLngToLayerPoint([arc.dst_lat, arc.dst_lng])
        const dx  = dst.x - src.x, dy = dst.y - src.y
        const len = Math.sqrt(dx * dx + dy * dy) || 1
        const cx  = (src.x + dst.x) / 2 - (dy / len) * (len * 0.3)
        const cy  = (src.y + dst.y) / 2 + (dx / len) * (len * 0.3)
        return `M${src.x},${src.y} Q${cx},${cy} ${dst.x},${dst.y}`
      })

      // 1st pass — visible styled arcs (pointer-events off; hit area handles them)
      const visibleNodes = pathDs.map((d, i) => {
        const arc   = geoData.arcs[i]
        const style = ARC_STYLE[arc.arc_type ?? 'wan'] ?? ARC_STYLE.wan
        const node  = arcG.append('path')
          .attr('d', d)
          .attr('stroke', style.color)
          .attr('stroke-width', widthScale(arc.bytes))
          .attr('stroke-dasharray', style.dash || null)
          .attr('fill', 'none')
          .attr('opacity', 0.6)
          .attr('stroke-linecap', 'round')
          .style('pointer-events', 'none')
          .node()
        return node
      })

      // 2nd pass — wide transparent hit areas
      pathDs.forEach((d, i) => {
        const arc   = geoData.arcs[i]
        const vis   = visibleNodes[i]
        const style = ARC_STYLE[arc.arc_type ?? 'wan'] ?? ARC_STYLE.wan
        const baseW = widthScale(arc.bytes)
        const typeLabel = style.label

        arcG.append('path')
          .attr('d', d)
          .attr('stroke', 'transparent')
          .attr('stroke-width', 14)
          .attr('fill', 'none')
          .style('pointer-events', 'stroke')
          .style('cursor', 'pointer')
          .on('mouseenter', () => {
            d3.select(vis).attr('opacity', 0.95).attr('stroke-width', baseW + 2)
          })
          .on('mouseleave', () => {
            d3.select(vis).attr('opacity', 0.6).attr('stroke-width', baseW)
          })
          .on('click', () => {
            window.open(
              `/explorer?src_ip=${arc.src_ip}&dst_ip=${arc.dst_ip}`,
              '_blank', 'noopener'
            )
          })
          .append('title')
            .text(
              `${arc.src_ip} → ${arc.dst_ip}\n` +
              `${typeLabel}\n` +
              `${fmt(arc.bytes)} · ${fmtNum(arc.flows)} flows\n` +
              `Click to explore flows`
            )
      })
    }

    drawArcs()
    map.on('moveend zoomend', drawArcs)
    return () => { map.off('moveend zoomend', drawArcs) }
  }, [geoData])

  return (
    <>
      <style>{`
        .pf-geo-tooltip { background: transparent !important; border: none !important;
          box-shadow: none !important; padding: 0 !important; }
        .pf-geo-tooltip::before { display: none !important; }
        .leaflet-container { background: #0f172a; }
      `}</style>
      <div ref={divRef} style={{ width: '100%', height: '100%' }} />
    </>
  )
}

// ── VPN Mappings Panel ─────────────────────────────────────────────────────
const GROUP_BADGE: Record<string, string> = {
  medical: 'bg-violet-800 text-violet-200',
  dental:  'bg-emerald-800 text-emerald-200',
  other:   'bg-gray-700 text-gray-300',
}
const TYPE_BADGE: Record<string, string> = {
  gp:  'bg-emerald-700 text-emerald-100',
  s2s: 'bg-blue-700 text-blue-100',
}

function VpnPanel({ onClose, isAdmin }: { onClose: () => void; isAdmin: boolean }) {
  const [mappings, setMappings] = useState<VpnMapping[]>([])
  const [loading,  setLoading]  = useState(true)
  const [showAdd,  setShowAdd]  = useState(false)
  const [form, setForm] = useState<VpnMappingIn>({
    site_name: '', group_name: 'medical', public_ip: '', cidr_or_ip: '', entry_type: 's2s',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  useEffect(() => {
    api.getVpnMappings()
      .then(setMappings)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function handleAdd() {
    if (!form.site_name.trim() || !form.public_ip.trim() || !form.cidr_or_ip.trim()) {
      setError('All fields are required')
      return
    }
    setSaving(true); setError('')
    try {
      const m = await api.createVpnMapping(form)
      setMappings(prev => [...prev, m])
      setForm({ site_name: '', group_name: 'medical', public_ip: '', cidr_or_ip: '', entry_type: 's2s' })
      setShowAdd(false)
    } catch (e: any) {
      setError(e.message ?? 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: number) {
    try {
      await api.deleteVpnMapping(id)
      setMappings(prev => prev.filter(m => m.id !== id))
    } catch {}
  }

  // Group by group_name for display
  const byGroup: Record<string, VpnMapping[]> = {}
  for (const m of mappings) {
    const g = m.group_name || 'other'
    if (!byGroup[g]) byGroup[g] = []
    byGroup[g].push(m)
  }

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl p-3 flex-shrink-0">
      {/* Panel header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider flex items-center gap-1.5">
          <Network size={12} className="text-blue-400" />
          VPN Site Mappings
        </span>
        <div className="flex items-center gap-2">
          {isAdmin && !showAdd && (
            <button
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              <Plus size={11} /> Add
            </button>
          )}
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Mapping list */}
      {loading ? (
        <p className="text-xs text-gray-500 text-center py-3">Loading…</p>
      ) : (
        <div className="overflow-y-auto max-h-44 space-y-2.5">
          {Object.keys(byGroup).length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-3">No VPN mappings configured</p>
          ) : (
            Object.entries(byGroup).map(([group, items]) => (
              <div key={group}>
                <div className={`inline-block text-xs font-medium px-1.5 py-0.5 rounded mb-1 ${GROUP_BADGE[group] ?? GROUP_BADGE.other}`}>
                  {group.charAt(0).toUpperCase() + group.slice(1)}
                </div>
                <table className="w-full text-xs border-collapse">
                  <tbody>
                    {items.map(m => (
                      <tr key={m.id} className="group/row hover:bg-gray-800/50">
                        <td className="py-0.5 pr-3 text-white whitespace-nowrap">{m.site_name}</td>
                        <td className="py-0.5 pr-3 text-gray-400 font-mono">{m.public_ip}</td>
                        <td className="py-0.5 pr-3 text-gray-300 font-mono">{m.cidr_or_ip}</td>
                        <td className="py-0.5 pr-2">
                          <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${TYPE_BADGE[m.entry_type] ?? 'bg-gray-700 text-gray-300'}`}>
                            {m.entry_type.toUpperCase()}
                          </span>
                        </td>
                        {isAdmin && (
                          <td className="py-0.5 w-4">
                            <button
                              onClick={() => handleDelete(m.id)}
                              title="Delete mapping"
                              className="text-gray-700 hover:text-red-400 opacity-0 group-hover/row:opacity-100 transition-all"
                            >
                              <Trash2 size={11} />
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </div>
      )}

      {/* Add form */}
      {showAdd && isAdmin && (
        <div className="mt-2 pt-2 border-t border-gray-700">
          <div className="flex gap-1.5 mb-1.5">
            <input
              placeholder="Site name"
              value={form.site_name}
              onChange={e => setForm(f => ({ ...f, site_name: e.target.value }))}
              className="flex-1 min-w-0 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
            <select
              value={form.group_name}
              onChange={e => setForm(f => ({ ...f, group_name: e.target.value }))}
              className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
            >
              <option value="medical">Medical</option>
              <option value="dental">Dental</option>
              <option value="other">Other</option>
            </select>
            <input
              placeholder="Public IP"
              value={form.public_ip}
              onChange={e => setForm(f => ({ ...f, public_ip: e.target.value }))}
              className="w-32 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white placeholder-gray-500 font-mono focus:outline-none focus:border-blue-500"
            />
            <input
              placeholder="CIDR or IP"
              value={form.cidr_or_ip}
              onChange={e => setForm(f => ({ ...f, cidr_or_ip: e.target.value }))}
              className="w-32 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white placeholder-gray-500 font-mono focus:outline-none focus:border-blue-500"
            />
            <select
              value={form.entry_type}
              onChange={e => setForm(f => ({ ...f, entry_type: e.target.value }))}
              className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
            >
              <option value="s2s">S2S</option>
              <option value="gp">GP</option>
            </select>
          </div>
          {error && <p className="text-xs text-red-400 mb-1.5">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleAdd}
              disabled={saving}
              className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Add Mapping'}
            </button>
            <button
              onClick={() => { setShowAdd(false); setError('') }}
              className="px-3 py-1 text-xs text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const WINDOWS = ['1h', '6h', '24h', '7d', '30d']

// ── GeoPage — full nav page at /geo ────────────────────────────────────────
export function GeoPage() {
  const [timeWindow,   setTimeWindow]   = useState('1h')
  const [geoData,      setGeoData]      = useState<GeoDataResponse | null>(null)
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState(false)
  const [showVpnPanel, setShowVpnPanel] = useState(false)
  const isAdmin = getTokenRole() === 'admin'

  const load = useCallback(() => {
    setLoading(true); setError(false)
    api.getGeoData(timeWindow)
      .then(setGeoData)
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [timeWindow])

  useEffect(() => { load() }, [load])

  function popOut() {
    const tok  = getToken()
    const role = getTokenRole()
    if (tok && role) {
      sessionStorage.setItem('pf_pop_token', tok)
      sessionStorage.setItem('pf_pop_role',  role)
    }
    window.open(`/geomap?window=${timeWindow}`, '_blank', 'noopener')
  }

  const hasData = geoData && geoData.locations.length > 0

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <h1 className="text-xl font-semibold text-white">Geo Map</h1>
        <div className="flex items-center gap-3">
          {loading && <span className="text-xs text-gray-400 animate-pulse">Loading…</span>}
          <button
            onClick={() => setShowVpnPanel(v => !v)}
            title="VPN site mappings"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
              showVpnPanel
                ? 'bg-blue-600/20 border border-blue-500/40 text-blue-300'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            <Network size={13} /> VPN Sites
          </button>
          <button onClick={load} title="Refresh" className="p-1.5 rounded text-gray-400 hover:text-white transition-colors">
            <RefreshCw size={14} />
          </button>
          <button onClick={popOut} title="Open in separate window" className="p-1.5 rounded text-gray-400 hover:text-white transition-colors">
            <Maximize2 size={14} />
          </button>
          <div className="flex bg-gray-800 rounded-lg p-0.5 gap-0.5">
            {WINDOWS.map(w => (
              <button
                key={w}
                onClick={() => setTimeWindow(w)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  timeWindow === w ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
                }`}
              >{w}</button>
            ))}
          </div>
        </div>
      </div>

      {/* VPN panel (collapsible) */}
      {showVpnPanel && (
        <VpnPanel onClose={() => setShowVpnPanel(false)} isAdmin={isAdmin} />
      )}

      {/* Map */}
      <div className="flex-1 min-h-0 bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        {error ? (
          <div className="flex items-center justify-center h-full text-sm text-gray-500">
            Geo lookup unavailable — check network connectivity to ip-api.com
          </div>
        ) : !loading && geoData && !hasData ? (
          <div className="flex items-center justify-center h-full text-sm text-gray-500">
            No external IP traffic in the {timeWindow} window
          </div>
        ) : hasData ? (
          <LeafletGeoMap geoData={geoData!} />
        ) : null}
      </div>
    </div>
  )
}

// ── GeoMapCard — inline card for Analytics ────────────────────────────────
export function GeoMapCard({ timeWindow }: { timeWindow: string }) {
  const [geoData, setGeoData] = useState<GeoDataResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(false)

  const load = useCallback(() => {
    setLoading(true); setError(false)
    api.getGeoData(timeWindow)
      .then(setGeoData)
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [timeWindow])

  useEffect(() => { load() }, [load])

  function popOut() {
    const tok  = getToken()
    const role = getTokenRole()
    if (tok && role) {
      sessionStorage.setItem('pf_pop_token', tok)
      sessionStorage.setItem('pf_pop_role',  role)
    }
    window.open(`/geomap?window=${timeWindow}`, '_blank', 'noopener')
  }

  const hasData = geoData && geoData.locations.length > 0

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 flex flex-col h-full">
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <MapPin size={14} className="text-blue-400" />
          Traffic Geo Map
        </h2>
        <div className="flex items-center gap-1">
          {loading && <span className="text-xs text-gray-500 animate-pulse mr-1">Loading…</span>}
          <button onClick={load} title="Refresh" className="p-1 rounded text-gray-500 hover:text-gray-300 transition-colors">
            <RefreshCw size={13} />
          </button>
          <button onClick={popOut} title="Open full-screen in new window" className="p-1 rounded text-gray-500 hover:text-gray-300 transition-colors">
            <Maximize2 size={13} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 rounded-lg overflow-hidden">
        {error ? (
          <div className="flex items-center justify-center h-full text-xs text-gray-500">
            Geo lookup unavailable — check network connectivity
          </div>
        ) : !loading && geoData && !hasData ? (
          <div className="flex items-center justify-center h-full text-xs text-gray-500">
            No external IP traffic in this window
          </div>
        ) : hasData ? (
          <LeafletGeoMap geoData={geoData!} />
        ) : null}
      </div>
    </div>
  )
}

// ── GeoMapPage — fullscreen pop-out at /geomap ────────────────────────────
export default function GeoMapPage() {
  const [geoData, setGeoData] = useState<GeoDataResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(false)
  const [ready,   setReady]   = useState(false)

  const params     = new URLSearchParams(window.location.search)
  const timeWindow = params.get('window') ?? '1h'

  // Restore in-memory token from sessionStorage (written by parent before window.open())
  useEffect(() => {
    const tok  = sessionStorage.getItem('pf_pop_token')
    const role = sessionStorage.getItem('pf_pop_role')
    if (tok && role) {
      setToken(tok, role)
      sessionStorage.removeItem('pf_pop_token')
      sessionStorage.removeItem('pf_pop_role')
    }
    setReady(true)
  }, [])

  useEffect(() => {
    if (!ready) return
    setLoading(true)
    api.getGeoData(timeWindow)
      .then(setGeoData)
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [ready, timeWindow])

  const hasData = geoData && geoData.locations.length > 0

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#030712', display: 'flex', flexDirection: 'column' }}>
      {/* Minimal top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', borderBottom: '1px solid #1f2937', flexShrink: 0,
      }}>
        <span style={{ color: '#f9fafb', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#3b82f6' }}>◉</span>
          pktFlow — Traffic Geo Map ({timeWindow})
        </span>
        <button
          onClick={() => window.close()}
          style={{ color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}
          onMouseEnter={e => (e.currentTarget.style.color = '#f9fafb')}
          onMouseLeave={e => (e.currentTarget.style.color = '#6b7280')}
        >
          <X size={14} /> Close
        </button>
      </div>

      {/* Map fills remainder */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 14 }}>
            Fetching geo data…
          </div>
        )}
        {error && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', fontSize: 14 }}>
            Geo lookup unavailable
          </div>
        )}
        {!loading && geoData && !hasData && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', fontSize: 14 }}>
            No external IP traffic in the {timeWindow} window
          </div>
        )}
        {hasData && (
          <div style={{ width: '100%', height: '100%' }}>
            <LeafletGeoMap geoData={geoData!} />
          </div>
        )}
      </div>
    </div>
  )
}
