/**
 * GeoMap — IP geolocation traffic map
 *
 * Exports:
 *   GeoPage      → full nav page at /geo
 *   GeoMapCard   → inline card for the Analytics page
 *   default      → full-screen standalone pop-out at /geomap
 *
 * Arc line color/dash is resolved server-side (Settings → Geo Map → NAT
 * Mappings / Traffic Rules, each picking a Line Style directly) and comes
 * back on each arc already resolved — no client-side type lookup needed.
 *
 * Circle marker colours by site (configured in Settings → Geo Map → Sites):
 *   group_a → purple  (#b0a0dd)
 *   group_b → green   (#9aeabd)
 *   default → blue    (#8ad8ea)
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import * as d3 from 'd3'
import { Maximize2, RefreshCw, X, MapPin } from 'lucide-react'
import { api, setToken, getToken, getTokenRole } from '../api/client'
import { useAutoRefresh } from '../store/autoRefresh'
import type { GeoDataResponse, Site, NatMapping } from '../api/client'
import {
  useGeoConfig, filterGeoData, hasSelection, EMPTY_SELECTION, locKey,
  type GeoConfig, type LegendSelection,
} from '../utils/geoData'
import HelpButton from '../components/HelpButton'

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// ── Legend HTML ───────────────────────────────────────────────────────────
// Line entries are keyed by the Traffic Rule name that produced each arc
// (arc.label, set server-side), not the underlying Line Style's own label —
// so the legend reads "DNS - Cloudflare/Quad9" instead of a generic
// "Dashed Blue". Arcs with no matching rule (the neutral default gray for
// unmapped public<->public traffic) have no label and are omitted.
//
// Every row is clickable (data-kind + data-key, read by a delegated click
// listener on the legend's container — see LeafletGeoMap) and every
// category is scoped to what's actually in geoData right now, not just
// what's configured with show_in_legend — an entry for traffic that isn't
// on screen is pointless to offer as a filter.
function buildLegendHTML(geoData: GeoDataResponse, cfg: GeoConfig, selection: LegendSelection): string {
  const heading = (t: string) =>
    `<div style="color:#a9a294;font-weight:600;margin-bottom:3px;font-size:10px;text-transform:uppercase;letter-spacing:.05em">${t}</div>`

  const row = (kind: string, key: string, selected: boolean, marginBottom: boolean, inner: string) =>
    `<div class="pf-legend-row${selected ? ' pf-legend-selected' : ''}" data-kind="${kind}" data-key="${escapeHtml(key)}"
      style="display:flex;align-items:center;gap:7px;cursor:pointer;padding:2px 4px;margin:-2px -4px${marginBottom ? ' -2px -4px 2px -4px' : ' -2px -4px'};border-radius:4px;">
      ${inner}
    </div>`

  const seenLabels = new Set<string>()
  const usedArcs: { color: string; dash: string; label: string }[] = []
  for (const arc of geoData.arcs) {
    if (!arc.label || seenLabels.has(arc.label)) continue
    seenLabels.add(arc.label)
    usedArcs.push({ color: arc.color, dash: arc.dash, label: arc.label })
  }

  const arcEntries = usedArcs.map(a => {
    const da = a.dash ? ` stroke-dasharray="${a.dash}"` : ''
    return row('line', a.label, selection.lines.has(a.label), true,
      `<svg width="26" height="7"><line x1="0" y1="3.5" x2="26" y2="3.5" stroke="${a.color}" stroke-width="2"${da}/></svg>
      ${escapeHtml(a.label)}`)
  }).join('')

  // Present = actually showing up in the current traffic, not just configured.
  const presentSiteKeys = new Set(geoData.locations.map(l => l.site_key).filter(Boolean))
  const legendSites = cfg.sites.filter(s => s.show_in_legend && presentSiteKeys.has(s.name))
  const siteEntries = legendSites.map((s, i) =>
    row('site', s.name, selection.sites.has(s.name), i < legendSites.length - 1,
      `<div style="width:10px;height:10px;border-radius:50%;background:${s.fill_color};border:1.5px solid ${s.stroke_color};flex-shrink:0"></div>
      ${escapeHtml(s.display_name)}`)
  ).join('')

  // A NAT Mapping's identity shows up as loc.site_name when that location was
  // resolved through it (see app/api/flows.py — site_name = meta["name"]).
  const presentMappingNames = new Set(geoData.locations.map(l => l.site_name).filter(Boolean))
  const legendMappings = cfg.natMappings.filter(m => m.show_in_legend && presentMappingNames.has(m.name))
  const mappingEntries = legendMappings.map((m, i) => {
    // Swatch matches the mapping's own Site color — a NAT Mapping carries no
    // color of its own, it inherits its Site's.
    const site = cfg.sites.find(s => s.name === m.site_key)
    const fill   = site?.fill_color   ?? cfg.defaultFill
    const stroke = site?.stroke_color ?? cfg.defaultStroke
    return row('mapping', m.name, selection.mappings.has(m.name), i < legendMappings.length - 1,
      `<div style="width:10px;height:10px;border-radius:50%;background:${fill};border:1.5px solid ${stroke};flex-shrink:0"></div>
      ${escapeHtml(m.name)}`)
  }).join('')

  const resetRow = hasSelection(selection)
    ? `<button data-action="reset" style="margin-top:6px;width:100%;text-align:center;font-size:10px;padding:3px 0;border-radius:4px;border:1px solid #5c6470;color:#a9a294;cursor:pointer;background:transparent">Reset</button>`
    : ''

  return (arcEntries ? heading('Line Styles') + `<div style="margin-bottom:6px">${arcEntries}</div>` : '') +
    (siteEntries ? heading('Sites') + `<div style="margin-bottom:6px">${siteEntries}</div>` : '') +
    (mappingEntries ? heading('NAT Mappings') + `<div>${mappingEntries}</div>` : '') +
    resetRow
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
  const divRef      = useRef<HTMLDivElement>(null)
  const mapRef      = useRef<L.Map | null>(null)
  const markersRef  = useRef<L.CircleMarker[]>([])
  const legendDivRef = useRef<HTMLDivElement | null>(null)
  const configRef   = useRef(config)
  useEffect(() => { configRef.current = config }, [config])

  // Legend click-to-filter selection. Resets whenever a genuinely new
  // geoData object arrives (auto-refresh tick or manual reload) — a
  // selected item might not even exist in the new data, and the spec calls
  // for the legend/filter to come back fresh on every refresh.
  const [selection, setSelection] = useState<LegendSelection>(EMPTY_SELECTION)
  useEffect(() => { setSelection(EMPTY_SELECTION) }, [geoData])

  // Initialise Leaflet once
  useEffect(() => {
    if (!divRef.current || mapRef.current) return
    const cfg = configRef.current

    const worldBounds = L.latLngBounds([-90, -180], [90, 180])

    const map = L.map(divRef.current, {
      center: [20, 0], zoom: 2, minZoom: 2,
      zoomControl: true, attributionControl: false,
      worldCopyJump: false,
      maxBounds: worldBounds, maxBoundsViscosity: 1.0,
    })

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 19,
      noWrap: true, bounds: worldBounds,
    }).addTo(map)

    // D3 arc overlay pane
    L.svg({ pane: 'overlayPane' }).addTo(map)

    // ── Dynamic legend (Leaflet control) ────────────────────────────────────
    // Content is rebuilt whenever geoData or the selection changes (see the
    // effect below) so the legend only ever lists what's currently on
    // screen. One delegated click listener handles every row plus the
    // Reset button — it survives each innerHTML rebuild since it's bound to
    // this stable container, not the rows themselves.
    const legend = new L.Control({ position: 'bottomleft' })
    legend.onAdd = () => {
      const div = L.DomUtil.create('div')
      div.style.cssText = `
        background:rgba(17,24,39,0.88);border:1px solid #2a2418;border-radius:8px;
        padding:8px 11px;font-size:11px;line-height:1.7;color:#dcd6c9;
        user-select:none;
      `
      div.innerHTML = buildLegendHTML(geoData, configRef.current, EMPTY_SELECTION)
      // The legend used to be pointer-events:none (fully click-through); now
      // that it's interactive, stop clicks/drags/scroll on it from also
      // reaching the map underneath (pan/zoom), matching Leaflet's own
      // built-in controls.
      L.DomEvent.disableClickPropagation(div)
      L.DomEvent.disableScrollPropagation(div)
      div.addEventListener('click', (e) => {
        const target = (e.target as HTMLElement).closest('[data-kind][data-key], [data-action="reset"]') as HTMLElement | null
        if (!target) return
        if (target.dataset.action === 'reset') {
          setSelection(EMPTY_SELECTION)
          return
        }
        const kind = target.dataset.kind as 'line' | 'site' | 'mapping'
        const key  = target.dataset.key!
        setSelection(prev => {
          const next: LegendSelection = { lines: new Set(prev.lines), sites: new Set(prev.sites), mappings: new Set(prev.mappings) }
          const set = kind === 'line' ? next.lines : kind === 'site' ? next.sites : next.mappings
          if (set.has(key)) set.delete(key); else set.add(key)
          return next
        })
      })
      legendDivRef.current = div
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

    if (legendDivRef.current) legendDivRef.current.innerHTML = buildLegendHTML(geoData, configRef.current, selection)

    // Locations/arcs actually drawn below — the full dataset when nothing's
    // selected in the legend, or the subset matching the selection (both
    // endpoints of any qualifying arc always included) otherwise.
    const visible = filterGeoData(geoData, selection)

    if (!visible.locations.length) return

    // Fit bounds to data
    const latlngs = visible.locations.map(l => [l.lat, l.lng] as [number, number])
    if (latlngs.length === 1) {
      map.setView(latlngs[0], 5)
    } else {
      map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40], maxZoom: 8 })
    }

    // Circle size scale
    const maxBytes = Math.max(...visible.locations.map(l => l.bytes), 1)
    const rScale   = d3.scaleSqrt().domain([0, maxBytes]).range([6, 24])

    // Draw location circles, coloured by site
    visible.locations.forEach(loc => {
      const r      = rScale(loc.bytes)
      const cfg    = configRef.current
      const fill   = cfg.siteColors[loc.site_key ?? '']  ?? cfg.defaultFill
      const stroke = cfg.siteStrokes[loc.site_key ?? ''] ?? cfg.defaultStroke

      const displayLabel = loc.site_name
        ? `${loc.site_name} <span style="color:#a9a294;font-size:10px">(${loc.site_key})</span>`
        : `<span style="font-family:monospace;color:#63c3d8">${loc.ip}</span>`

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
          `<div style="background:#0d1219;border:1px solid #2a2418;border-radius:6px;padding:8px 10px;font-size:12px;line-height:1.6;color:#f5f1e8">
            <div style="font-weight:600">${displayLabel}</div>
            <div style="color:#a9a294">${locationLine}</div>
            <div>${fmt(loc.bytes)} · ${fmtNum(loc.flows)} flows</div>
            <div style="color:#a9a294;font-size:11px;margin-top:4px">Click to explore flows</div>
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

    const maxArcBytes  = Math.max(...visible.arcs.map(a => a.bytes), 1)
    const widthScale   = d3.scaleSqrt().domain([0, maxArcBytes]).range([0.8, 4])

    // ── live layer: keyframes + glow, mounted once into the overlay SVG ──
    // Leaflet redraws this group on every pan/zoom, so the defs are guarded
    // rather than appended each pass.
    function ensureLiveDefs() {
      const node = arcG.node() as SVGGElement | null
      const svg = node?.ownerSVGElement
      if (!svg) return
      const sel = d3.select(svg)
      if (!sel.select('#geo-live-defs').empty()) return

      const defs = sel.append('defs').attr('id', 'geo-live-defs')
      const f = defs.append('filter').attr('id', 'geo-glow')
        .attr('x', '-40%').attr('y', '-40%').attr('width', '180%').attr('height', '180%')
      f.append('feGaussianBlur').attr('stdDeviation', 2).attr('result', 'b')
      const merge = f.append('feMerge')
      merge.append('feMergeNode').attr('in', 'b')
      merge.append('feMergeNode').attr('in', 'SourceGraphic')

      sel.append('style').text(`
        @keyframes geo-flow { to { stroke-dashoffset: -260; } }
        .geo-arc-pulse {
          stroke-dasharray: 2 22;
          animation: geo-flow 4s linear infinite;
          pointer-events: none;
        }
        @media (prefers-reduced-motion: reduce) {
          .geo-arc-pulse { animation: none; opacity: 0 !important; }
        }
      `)
    }

    function drawArcs() {
      if (!mapRef.current) return
      arcG.selectAll('*').remove()
      ensureLiveDefs()

      const pathDs = visible.arcs.map(arc => {
        const src = mapRef.current!.latLngToLayerPoint([arc.src_lat, arc.src_lng])
        const dst = mapRef.current!.latLngToLayerPoint([arc.dst_lat, arc.dst_lng])
        const dx  = dst.x - src.x, dy = dst.y - src.y
        const len = Math.sqrt(dx * dx + dy * dy) || 1
        const cx  = (src.x + dst.x) / 2 - (dy / len) * (len * 0.3)
        const cy  = (src.y + dst.y) / 2 + (dx / len) * (len * 0.3)
        return `M${src.x},${src.y} Q${cx},${cy} ${dst.x},${dst.y}`
      })

      // 1st pass — visible styled arcs (pointer-events off; hit area handles them)
      // color/dash come resolved directly from the backend (NAT Mappings /
      // Traffic Rules each pick a Line Style) — no client-side lookup needed.
      const visibleNodes = pathDs.map((d, i) => {
        const arc  = visible.arcs[i]
        const node = arcG.append('path')
          .attr('d', d)
          .attr('stroke', arc.color)
          .attr('stroke-width', widthScale(arc.bytes))
          .attr('stroke-dasharray', arc.dash || null)
          .attr('fill', 'none')
          .attr('opacity', 0.6)
          .attr('stroke-linecap', 'round')
          .style('pointer-events', 'none')
          .node()
        return node
      })

      // 1.5th pass — a charge travelling src -> dst along each arc. Speed
      // carries volume (busiest arc fastest), matching the Sankey ribbons, and
      // it is drawn on the same path so it cannot imply a route that is not
      // there. Pointer events stay off so the hit areas below still own
      // interaction.
      const maxArcBytes = Math.max(1, ...visible.arcs.map(a => a.bytes))
      pathDs.forEach((d, i) => {
        const arc = visible.arcs[i]
        const frac = Math.min(1, Math.max(0, arc.bytes / maxArcBytes))
        const dur = (7 - Math.sqrt(frac) * 4.6).toFixed(2)   // 7s quiet -> 2.4s busiest
        arcG.append('path')
          .attr('d', d)
          .attr('stroke', arc.color)
          .attr('stroke-width', Math.min(widthScale(arc.bytes) * 0.9, 3))
          .attr('stroke-linecap', 'round')
          .attr('fill', 'none')
          .attr('class', 'geo-arc-pulse')
          .attr('filter', 'url(#geo-glow)')
          .style('animation-duration', `${dur}s`)
          .style('animation-delay', `${(i % 6) * 0.4}s`)
      })

      // Radar pings on the locations. Drawn in the overlay rather than on the
      // Leaflet markers so they redraw with pan/zoom and never intercept
      // clicks. SMIL rather than CSS because animating the r geometry
      // attribute through CSS is not reliable across browsers.
      visible.locations.forEach((loc, i) => {
        const pt = mapRef.current!.latLngToLayerPoint([loc.lat, loc.lng])
        const gcfg = configRef.current
        const stroke = gcfg.siteStrokes[loc.site_key ?? ''] ?? gcfg.defaultStroke
        const ring = arcG.append('circle')
          .attr('cx', pt.x).attr('cy', pt.y)
          .attr('r', 3)
          .attr('fill', 'none')
          .attr('stroke', stroke)
          .attr('stroke-width', 1.1)
          .style('pointer-events', 'none')
        const begin = `${((i % 5) * 0.7).toFixed(2)}s`
        ring.append('animate')
          .attr('attributeName', 'r').attr('values', '3;18')
          .attr('dur', '3s').attr('begin', begin).attr('repeatCount', 'indefinite')
        ring.append('animate')
          .attr('attributeName', 'opacity').attr('values', '0.65;0')
          .attr('dur', '3s').attr('begin', begin).attr('repeatCount', 'indefinite')
      })

      // 2nd pass — wide transparent hit areas
      pathDs.forEach((d, i) => {
        const arc   = visible.arcs[i]
        const vis   = visibleNodes[i]
        const baseW = widthScale(arc.bytes)

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
              (arc.label ? `${arc.label}\n` : '') +
              `${arc.src_ip} → ${arc.dst_ip}\n` +
              `${fmt(arc.bytes)} · ${fmtNum(arc.flows)} flows\n` +
              `Click to explore flows`
            )
      })
    }

    drawArcs()
    map.on('moveend zoomend', drawArcs)
    return () => { map.off('moveend zoomend', drawArcs) }
  }, [geoData, selection])

  return (
    <>
      <style>{`
        .pf-geo-tooltip { background: transparent !important; border: none !important;
          box-shadow: none !important; padding: 0 !important; }
        .pf-geo-tooltip::before { display: none !important; }
        .leaflet-container { background: #04060a; }
        .pf-legend-row:hover { background: rgba(255,255,255,0.08); }
        .pf-legend-selected { background: rgba(59,130,246,0.28) !important; }
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
  const { tick } = useAutoRefresh()

  const load = useCallback(() => {
    setLoading(true); setError(false)
    api.getGeoData(timeWindow)
      .then(setGeoData)
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [timeWindow])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (tick > 0) load() }, [tick])

  function popOut() {
    const tok  = getToken()
    const role = getTokenRole()
    if (tok && role) {
      sessionStorage.setItem('pf_pop_token', tok)
      sessionStorage.setItem('pf_pop_role',  role)
    }
    window.open(`/geomap?window=${timeWindow}`, '_blank')
  }

  const hasData = geoData && geoData.locations.length > 0

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold text-white">Geo Map</h1>
          <HelpButton title="Geo Map — How It Works">
            <p>Every arc and marker on this page is driven entirely by <span className="text-gray-300 font-medium">Settings → Geo Map</span> — NAT Mappings place your private ranges at a real-world location, Traffic Rules decide each arc's color/dash style, Sites color the circle markers (by IP/CIDR match on the remote end, or via a NAT Mapping on the local end). This page has no styling controls of its own.</p>
            <p>Click any marker or arc to jump into Flow Explorer, pre-filtered to that location's or that conversation's traffic.</p>
            <p><span className="text-gray-300 font-medium">The legend is clickable</span> — click a Line Style, Site, or NAT Mapping to filter the map to just that item and everything connected to it; click more to add them (any combination, shown together). A Reset button appears at the bottom of the legend once something's selected. The filter clears automatically on the next refresh. Legend entries themselves only ever list what's actually in the current traffic.</p>
            <p><span className="text-gray-300 font-medium">Pop-out</span> opens the map as a real separate browser window rather than a modal — its Close button actually closes just that window, and it keeps itself refreshed on its own 30s timer independent of this page's auto-refresh setting.</p>
          </HelpButton>
        </div>
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
  const { tick } = useAutoRefresh()

  const load = useCallback(() => {
    setLoading(true); setError(false)
    api.getGeoData(timeWindow)
      .then(setGeoData)
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [timeWindow])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (tick > 0) load() }, [tick])

  function popOut() {
    const tok  = getToken()
    const role = getTokenRole()
    if (tok && role) {
      sessionStorage.setItem('pf_pop_token', tok)
      sessionStorage.setItem('pf_pop_role',  role)
    }
    window.open(`/geomap?window=${timeWindow}`, '_blank')
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

  const load = useCallback(() => {
    if (!ready) return
    setLoading(true)
    api.getGeoData(timeWindow)
      .then(setGeoData)
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [ready, timeWindow])

  useEffect(() => { load() }, [load])

  // This window is a separate page load — it has no access to the main app's
  // AutoRefreshProvider context, so it keeps itself fresh on a fixed interval
  // instead (the pop-out has no settings UI to configure one anyway).
  useEffect(() => {
    if (!ready) return
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [ready, load])

  const hasData = geoData && geoData.locations.length > 0

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#04060a', display: 'flex', flexDirection: 'column' }}>
      {/* Minimal top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', borderBottom: '1px solid #211c14', flexShrink: 0,
      }}>
        <span style={{ color: '#f5f1e8', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#8ad8ea' }}>◉</span>
          pktFlow — Traffic Geo Map ({timeWindow})
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {loading && <span style={{ color: '#a9a294', fontSize: 11 }}>Refreshing…</span>}
          <button
            onClick={load} title="Refresh"
            style={{ color: '#a9a294', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#f5f1e8')}
            onMouseLeave={e => (e.currentTarget.style.color = '#a9a294')}
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            onClick={() => window.close()}
            style={{ color: '#a9a294', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#f5f1e8')}
            onMouseLeave={e => (e.currentTarget.style.color = '#a9a294')}
          >
            <X size={14} /> Close
          </button>
        </div>
      </div>

      {/* Map fills remainder */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a9a294', fontSize: 14 }}>
            Fetching geo data…
          </div>
        )}
        {error && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a9a294', fontSize: 14 }}>
            Geo lookup unavailable
          </div>
        )}
        {!loading && geoData && !hasData && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a9a294', fontSize: 14 }}>
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
