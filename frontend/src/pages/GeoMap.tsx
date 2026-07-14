/**
 * GeoMap — IP geolocation traffic map
 *
 * Exports:
 *   GeoPage      → full nav page at /geo
 *   GeoMapCard   → inline card for the Analytics page
 *   default      → full-screen standalone pop-out at /geomap
 *
 * Arc line styles by type:
 *   gp  — GlobalProtect VPN  → green  (#10b981), dash-dash-dot
 *   s2s — Site-to-Site VPN   → blue   (#3b82f6), dashed
 *   wan — Regular WAN traffic → red    (#ef4444), solid
 *
 * Circle marker colours by group (configured in Settings → Geo Map → Site Groups):
 *   group_a → purple  (#a78bfa)
 *   group_b → green   (#34d399)
 *   other   → blue    (#60a5fa)
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import * as d3 from 'd3'
import { Maximize2, RefreshCw, X, MapPin } from 'lucide-react'
import { api, setToken, getToken, getTokenRole } from '../api/client'
import type { GeoDataResponse, SiteGroup, TrafficType } from '../api/client'

// ── Geo config (dynamic — fetched from API, falls back to hardcoded defaults) ──
interface GeoConfig {
  arcStyles:    Record<string, { color: string; dash: string; label: string }>
  groupColors:  Record<string, string>
  groupStrokes: Record<string, string>
  defaultFill:  string
  defaultStroke: string
  siteGroups:   SiteGroup[]
  trafficTypes: TrafficType[]
}

const FALLBACK_CONFIG: GeoConfig = {
  arcStyles: {
    gp:  { color: '#10b981', dash: '8,3,8,3,2,3', label: 'GlobalProtect VPN' },
    s2s: { color: '#3b82f6', dash: '10,5',         label: 'Site-to-Site VPN'  },
    wan: { color: '#ef4444', dash: '',             label: 'WAN Traffic'       },
  },
  groupColors:  { group_a: '#a78bfa', group_b: '#34d399' },
  groupStrokes: { group_a: '#c4b5fd', group_b: '#6ee7b7' },
  defaultFill:  '#ef4444',
  defaultStroke: '#fca5a5',
  siteGroups:   [],
  trafficTypes: [],
}

function buildConfig(trafficTypes: TrafficType[], siteGroups: SiteGroup[]): GeoConfig {
  const arcStyles: Record<string, { color: string; dash: string; label: string }> = {}
  let   defaultFill   = '#60a5fa'
  let   defaultStroke = '#93c5fd'

  for (const t of trafficTypes) {
    arcStyles[t.name] = {
      color: t.line_color ?? '#6b7280',
      dash:  t.line_dash  ?? '',
      label: t.label,
    }
  }
  // Ensure there is always a 'wan' key (used as fallback for unmatched arcs)
  if (!arcStyles['wan']) {
    const def = trafficTypes.find(t => t.is_default)
    arcStyles['wan'] = def
      ? { color: def.line_color ?? '#ef4444', dash: def.line_dash ?? '', label: def.label }
      : FALLBACK_CONFIG.arcStyles['wan']
  }

  const groupColors:  Record<string, string> = {}
  const groupStrokes: Record<string, string> = {}
  for (const g of siteGroups) {
    groupColors[g.name]  = g.fill_color
    groupStrokes[g.name] = g.stroke_color
  }

  // External (non-VPN) marker colour: use the 'wan' arc colour as a hint,
  // or fall back to red if no wan arc style is configured
  const extGroup = siteGroups.find(g => g.name === 'external') ?? null
  if (extGroup) {
    defaultFill   = extGroup.fill_color
    defaultStroke = extGroup.stroke_color
  }

  return { arcStyles, groupColors, groupStrokes, defaultFill, defaultStroke, siteGroups, trafficTypes }
}

// Module-level cache so config is fetched once per page load
let _configCache: GeoConfig | null = null
let _configPromise: Promise<GeoConfig> | null = null

function fetchGeoConfig(): Promise<GeoConfig> {
  if (_configCache) return Promise.resolve(_configCache)
  if (!_configPromise) {
    _configPromise = Promise.all([api.getTrafficTypes(), api.getSiteGroups()])
      .then(([tt, sg]) => { _configCache = buildConfig(tt, sg); return _configCache })
      .catch(() => { _configCache = FALLBACK_CONFIG; return _configCache })
  }
  return _configPromise
}

function useGeoConfig(): GeoConfig | null {
  const [config, setConfig] = useState<GeoConfig | null>(_configCache)
  useEffect(() => {
    if (!_configCache) { fetchGeoConfig().then(setConfig) }
  }, [])
  return config
}

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
function LeafletGeoMap({ geoData, config }: { geoData: GeoDataResponse; config: GeoConfig }) {
  const divRef     = useRef<HTMLDivElement>(null)
  const mapRef     = useRef<L.Map | null>(null)
  const markersRef = useRef<L.CircleMarker[]>([])
  const configRef  = useRef(config)
  useEffect(() => { configRef.current = config }, [config])

  // Initialise Leaflet once
  useEffect(() => {
    if (!divRef.current || mapRef.current) return
    const cfg = configRef.current

    const map = L.map(divRef.current, {
      center: [20, 0], zoom: 2,
      zoomControl: true, attributionControl: false,
    })

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 19,
    }).addTo(map)

    // D3 arc overlay pane
    L.svg({ pane: 'overlayPane' }).addTo(map)

    // ── Dynamic legend (Leaflet control) ──────────────────────────────────
    const legend = new L.Control({ position: 'bottomleft' })
    legend.onAdd = () => {
      const div = L.DomUtil.create('div')
      div.style.cssText = `
        background:rgba(17,24,39,0.88);border:1px solid #374151;border-radius:8px;
        padding:8px 11px;font-size:11px;line-height:1.7;color:#d1d5db;
        pointer-events:none;user-select:none;
      `
      const c = configRef.current
      const heading = (t: string) =>
        `<div style="color:#9ca3af;font-weight:600;margin-bottom:3px;font-size:10px;text-transform:uppercase;letter-spacing:.05em">${t}</div>`

      // Traffic types section
      const arcEntries = c.trafficTypes.length
        ? c.trafficTypes.map(t => {
            const da = t.line_dash ? ` stroke-dasharray="${t.line_dash}"` : ''
            return `<div style="display:flex;align-items:center;gap:7px;margin-bottom:2px">
              <svg width="26" height="7"><line x1="0" y1="3.5" x2="26" y2="3.5" stroke="${t.line_color ?? '#6b7280'}" stroke-width="2"${da}/></svg>
              ${t.label}
            </div>`
          }).join('')
        : Object.entries(c.arcStyles).map(([, s]) => {
            const da = s.dash ? ` stroke-dasharray="${s.dash}"` : ''
            return `<div style="display:flex;align-items:center;gap:7px;margin-bottom:2px">
              <svg width="26" height="7"><line x1="0" y1="3.5" x2="26" y2="3.5" stroke="${s.color}" stroke-width="2"${da}/></svg>
              ${s.label}
            </div>`
          }).join('')

      // Site groups section
      const siteEntries = c.siteGroups.length
        ? c.siteGroups.map((g, i) =>
            `<div style="display:flex;align-items:center;gap:7px;${i < c.siteGroups.length - 1 ? 'margin-bottom:2px' : ''}">
              <div style="width:10px;height:10px;border-radius:50%;background:${g.fill_color};border:1.5px solid ${g.stroke_color};flex-shrink:0"></div>
              ${g.display_name}
            </div>`
          ).join('')
        : `<div style="display:flex;align-items:center;gap:7px;margin-bottom:2px">
            <div style="width:10px;height:10px;border-radius:50%;background:#a78bfa;flex-shrink:0"></div>Group A
          </div>
          <div style="display:flex;align-items:center;gap:7px;margin-bottom:2px">
            <div style="width:10px;height:10px;border-radius:50%;background:#34d399;flex-shrink:0"></div>Group B
          </div>
          <div style="display:flex;align-items:center;gap:7px">
            <div style="width:10px;height:10px;border-radius:50%;background:#ef4444;flex-shrink:0"></div>External
          </div>`

      div.innerHTML =
        heading('Traffic Type') +
        `<div style="margin-bottom:6px">${arcEntries}</div>` +
        heading('Sites') +
        siteEntries

      return div
    }
    legend.addTo(map)

    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const cfg    = configRef.current
      const fill   = cfg.groupColors[loc.group ?? '']  ?? cfg.defaultFill
      const stroke = cfg.groupStrokes[loc.group ?? ''] ?? cfg.defaultStroke

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
          window.location.href = `/explorer?src_ip=${loc.ip}`
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
        const cfg   = configRef.current
        const style = cfg.arcStyles[arc.arc_type ?? 'wan'] ?? cfg.arcStyles['wan'] ?? FALLBACK_CONFIG.arcStyles['wan']
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
        const cfg   = configRef.current
        const style = cfg.arcStyles[arc.arc_type ?? 'wan'] ?? cfg.arcStyles['wan'] ?? FALLBACK_CONFIG.arcStyles['wan']
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
            window.location.href = `/explorer?src_ip=${arc.src_ip}&dst_ip=${arc.dst_ip}`
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

const WINDOWS = ['1h', '6h', '24h', '7d', '30d']

// ── GeoPage — full nav page at /geo ────────────────────────────────────────
export function GeoPage() {
  const [timeWindow, setTimeWindow] = useState('1h')
  const [geoData,    setGeoData]    = useState<GeoDataResponse | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(false)
  const config = useGeoConfig()

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
    window.location.href = `/geomap?window=${timeWindow}`
  }

  const hasData = geoData && geoData.locations.length > 0

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <h1 className="text-xl font-semibold text-white">Geo Map</h1>
        <div className="flex items-center gap-3">
          {loading && <span className="text-xs text-gray-400 animate-pulse">Loading…</span>}
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
        ) : hasData && config ? (
          <LeafletGeoMap geoData={geoData!} config={config} />
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
  const config = useGeoConfig()

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
    window.location.href = `/geomap?window=${timeWindow}`
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
        ) : hasData && config ? (
          <LeafletGeoMap geoData={geoData!} config={config} />
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
  const config = useGeoConfig()

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
        {hasData && config && (
          <div style={{ width: '100%', height: '100%' }}>
            <LeafletGeoMap geoData={geoData!} config={config} />
          </div>
        )}
      </div>
    </div>
  )
}
