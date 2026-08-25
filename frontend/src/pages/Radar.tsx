/**
 * Radar — PPI-scope reading of the same /flows/geo payload the Geo Map plots.
 *
 * Exports:
 *   RadarCard → inline card for the Analytics dashboard
 *   default   → full nav page at /radar
 *
 * Projection: the origin is the spherical centroid of the site-mapped
 * locations (i.e. your own network, placed by Settings → Geo Map → NAT
 * Mappings / Sites). Every location is then drawn at its true initial
 * bearing from that origin, at a log-compressed great-circle range, so a
 * 300 km hop and a 17 000 km hop both stay readable on one face.
 *
 * Nothing here re-derives styling: arcs already carry their resolved
 * color/dash/label from the backend, markers take their colour from the
 * Site config, and the legend groups and click-to-filter semantics are
 * shared with the Geo Map (filterGeoData) rather than reimplemented.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Maximize2, Radar as RadarIcon } from 'lucide-react'
import { api } from '../api/client'
import type { GeoDataResponse, GeoLocation, GeoArc } from '../api/client'
import { useAutoRefresh } from '../store/autoRefresh'
import HelpButton from '../components/HelpButton'
import { INSTRUMENT } from '../components/instrument'
import {
  useGeoConfig, filterGeoData, hasSelection, EMPTY_SELECTION, locKey,
  type GeoConfig, type LegendSelection,
} from '../utils/geoData'

const WINDOWS = ['1h', '6h', '24h', '7d', '30d']

// ── Scope geometry ─────────────────────────────────────────────────────────
// Fixed viewBox, scaled to the container by preserveAspectRatio — the face is
// always fully inside its box, on the dashboard card and on the full page
// alike, with no scrolling.
const VB = 640, CX = 320, CY = 320, R_MAX = 268
const D_MAX = 20015                       // half the earth's circumference, km
const RINGS = [500, 2000, 8000, 20000]

const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

interface LatLng { lat: number; lng: number }

function haversine(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

function bearing(a: LatLng, b: LatLng): number {
  const dLng = rad(b.lng - a.lng)
  const y = Math.sin(dLng) * Math.cos(rad(b.lat))
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
            Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng)
  return (deg(Math.atan2(y, x)) + 360) % 360
}

/** Spherical mean of unit vectors — an arithmetic mean of lng breaks at ±180. */
function centroid(points: LatLng[]): LatLng {
  if (!points.length) return { lat: 0, lng: 0 }
  let x = 0, y = 0, z = 0
  for (const p of points) {
    const phi = rad(p.lat), lam = rad(p.lng)
    x += Math.cos(phi) * Math.cos(lam)
    y += Math.cos(phi) * Math.sin(lam)
    z += Math.sin(phi)
  }
  x /= points.length; y /= points.length; z /= points.length
  if (Math.hypot(x, y, z) < 1e-9) return { lat: points[0].lat, lng: points[0].lng }
  return { lat: deg(Math.atan2(z, Math.hypot(x, y))), lng: deg(Math.atan2(y, x)) }
}

// Log range: near traffic stays legible instead of collapsing onto the origin,
// and the far half of the planet still fits inside the outer ring. The knee
// (the divisor) sets how much of the face the near field gets — most real
// traffic sits inside a few thousand km, so a low knee is what stops
// everything piling into the middle third.
const KNEE = 22
const rangeR = (km: number) =>
  R_MAX * Math.log10(1 + Math.max(0, km) / KNEE) / Math.log10(1 + D_MAX / KNEE)

// ── Zoom (Radar page only) ─────────────────────────────────────────────────
// Positions scale, sizes don't: everything inside the zoom group divides its
// own radius / stroke / font by k, so zooming spreads contacts apart instead
// of inflating them. k === 1 is the untransformed face the dashboard card
// always renders.
const K_MIN = 1, K_MAX = 6
interface Zoom { k: number; tx: number; ty: number }
const NO_ZOOM: Zoom = { k: 1, tx: 0, ty: 0 }

function clampPan(z: Zoom): Zoom {
  const lim = (z.k - 1) * CX
  return { k: z.k, tx: Math.max(-lim, Math.min(lim, z.tx)), ty: Math.max(-lim, Math.min(lim, z.ty)) }
}

/** Zoom about a fixed scene point, so what's under the cursor stays put. */
function zoomAt(z: Zoom, px: number, py: number, factor: number): Zoom {
  const k = Math.max(K_MIN, Math.min(K_MAX, z.k * factor))
  if (k === z.k) return z
  const r = k / z.k
  return clampPan({ k, tx: px - CX - (px - CX - z.tx) * r, ty: py - CY - (py - CY - z.ty) * r })
}

/** Client coords → viewBox coords, accounting for preserveAspectRatio letterboxing. */
function toScene(el: HTMLElement, clientX: number, clientY: number): [number, number] {
  const rect = el.getBoundingClientRect()
  const s = Math.min(rect.width, rect.height) / VB
  return [
    (clientX - rect.left - (rect.width  - VB * s) / 2) / s,
    (clientY - rect.top  - (rect.height - VB * s) / 2) / s,
  ]
}

/** Keep a dash pattern looking the same on screen as the scene scales. */
function scaleDash(dash: string, k: number): string | undefined {
  if (!dash) return undefined
  if (k === 1) return dash
  return dash.trim().split(/[\s,]+/).map(n => (Number(n) / k).toFixed(2)).join(' ')
}

const polar = (brg: number, r: number): [number, number] =>
  [CX + r * Math.sin(rad(brg)), CY - r * Math.cos(rad(brg))]

// ── Formatters ─────────────────────────────────────────────────────────────
function fmtBytes(n: number) {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`
  if (n >= 1e9)  return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6)  return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3)  return `${(n / 1e3).toFixed(1)} KB`
  return `${n} B`
}
const fmtNum = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)
const fmtKm = (k: number) =>
  k >= 1000 ? `${(k / 1000).toFixed(1)}k km` : `${Math.round(k)} km`
const brgLabel = (b: number) => `${String(Math.round(b) % 360).padStart(3, '0')}°`

// ── Contact placement ──────────────────────────────────────────────────────
interface Contact {
  loc: GeoLocation
  key: string
  x: number; y: number
  brg: number; dist: number
  r: number; halo: number
  fill: string; stroke: string
}

function placeContacts(geoData: GeoDataResponse, cfg: GeoConfig, origin: LatLng): Contact[] {
  const maxBytes = Math.max(1, ...geoData.locations.map(l => l.bytes))
  const maxFlows = Math.max(1, ...geoData.locations.map(l => l.flows))

  const placed = geoData.locations.map(loc => {
    const dist = haversine(origin, loc)
    const brg  = dist < 1 ? 0 : bearing(origin, loc)
    const [x, y] = polar(brg, rangeR(dist))
    const r    = 3 + 8 * Math.sqrt(loc.bytes / maxBytes)
    return {
      loc,
      key:  locKey(loc.ip, loc.lat, loc.lng),
      x, y, brg, dist, r,
      halo: r + 2.5 + 6 * Math.sqrt(loc.flows / maxFlows),
      fill:   (loc.site_key && cfg.siteColors[loc.site_key])  || cfg.defaultFill,
      stroke: (loc.site_key && cfg.siteStrokes[loc.site_key]) || cfg.defaultStroke,
    }
  })

  // Polar compresses harder than a map does, so co-located contacts land on
  // top of each other. Stack them outward along their own bearing, each one
  // clearing the halo of the one before it — range shifts slightly, bearing
  // never does, so direction stays truthful.
  const cells = new Map<string, Contact[]>()
  for (const c of placed) {
    const cell = `${Math.round(c.x / 14)}|${Math.round(c.y / 14)}`
    const list = cells.get(cell)
    list ? list.push(c) : cells.set(cell, [c])
  }
  for (const list of cells.values()) {
    if (list.length < 2) continue
    list.sort((a, b) => b.loc.bytes - a.loc.bytes)
    let step = 0
    list.forEach((c, i) => {
      if (i) {
        step += list[i - 1].halo + c.halo + 5
        const rr = Math.min(R_MAX - c.halo - 2, Math.hypot(c.x - CX, c.y - CY) + step)
        const [nx, ny] = polar(c.brg, rr)
        c.x = nx; c.y = ny
      }
    })
  }
  return placed
}

// ── Scope ──────────────────────────────────────────────────────────────────
function RadarScope({
  geoData, config, compact = false, zoomable = false,
}: { geoData: GeoDataResponse; config: GeoConfig; compact?: boolean; zoomable?: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<LegendSelection>(EMPTY_SELECTION)
  const [hover, setHover] = useState<{ c: Contact; x: number; y: number } | null>(null)
  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM)
  const k = zoomable ? zoom.k : 1
  const dragRef = useRef<{ cx: number; cy: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)

  // Wheel has to be a non-passive native listener — React's synthetic onWheel
  // can't preventDefault, so the page would scroll while zooming.
  useEffect(() => {
    const el = wrapRef.current
    if (!zoomable || !el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const [px, py] = toScene(el, e.clientX, e.clientY)
      setZoom(z => zoomAt(z, px, py, e.deltaY < 0 ? 1.18 : 1 / 1.18))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomable])

  // A selected legend entry may not exist in the next payload at all, and the
  // Geo Map clears its filter on every refresh — match that here.
  useEffect(() => { setSelection(EMPTY_SELECTION) }, [geoData])

  const view = useMemo(() => filterGeoData(geoData, selection), [geoData, selection])

  // Origin: your own network. Site-mapped locations first; if nothing is
  // mapped yet, fall back to the centroid of everything so the face still
  // draws rather than collapsing onto 0,0 in the Gulf of Guinea.
  const origin = useMemo(() => {
    const mappingNames = new Set(config.natMappings.map(m => m.name))
    const local = geoData.locations.filter(l => l.site_name && mappingNames.has(l.site_name))
    const sited = geoData.locations.filter(l => l.site_key)
    const own = local.length ? local : sited.length ? sited : geoData.locations
    return centroid(own.map(l => ({ lat: l.lat, lng: l.lng })))
  }, [geoData, config])

  const contacts = useMemo(() => placeContacts(view, config, origin), [view, config, origin])
  const byKey = useMemo(() => new Map(contacts.map(c => [c.key, c])), [contacts])

  const labelled = useMemo(() => {
    const n = compact ? 5 : Math.min(contacts.length, Math.round(14 * k))
    return new Set([...contacts].sort((a, b) => b.loc.bytes - a.loc.bytes).slice(0, n).map(c => c.key))
  }, [contacts, compact, k])

  function toggle(kind: keyof LegendSelection, key: string) {
    setSelection(prev => {
      const next: LegendSelection = {
        lines:    new Set(prev.lines),
        sites:    new Set(prev.sites),
        mappings: new Set(prev.mappings),
      }
      next[kind].has(key) ? next[kind].delete(key) : next[kind].add(key)
      return next
    })
  }

  function onMove(e: React.MouseEvent, c: Contact) {
    const box = wrapRef.current?.getBoundingClientRect()
    if (!box) return
    setHover({ c, x: e.clientX - box.left, y: e.clientY - box.top })
  }

  // ── chrome: range rings, bearing spokes, sweep ───────────────────────────
  const spokes: JSX.Element[] = []
  for (let a = 0; a < 360; a += 15) {
    const major = a % 45 === 0
    const [x1, y1] = polar(a, major ? 24 : R_MAX - 9)
    const [x2, y2] = polar(a, R_MAX)
    spokes.push(
      <line key={`s${a}`} x1={x1} y1={y1} x2={x2} y2={y2}
            stroke={INSTRUMENT.gold} strokeWidth={(major ? 0.6 : 1) / k}
            opacity={major ? 0.14 : 0.38} />
    )
    if (major) {
      const [lx, ly] = polar(a, R_MAX + 16)
      const card: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }
      spokes.push(
        <text key={`t${a}`} x={lx} y={ly + 3 / k} textAnchor="middle"
              fontFamily="ui-monospace, SF Mono, Menlo, monospace"
              fontSize={(a % 90 === 0 ? 10 : 8.5) / k} letterSpacing={1.2 / k}
              fill={a % 90 === 0 ? INSTRUMENT.gold : INSTRUMENT.inkDim}
              opacity={a % 90 === 0 ? 0.95 : 0.7}>
          {card[a] ?? String(a).padStart(3, '0')}
        </text>
      )
    }
  }

  const trail = Array.from({ length: 26 }, (_, i) => {
    const a0 = -i * 3.2, a1 = a0 - 3.3
    const [ax, ay] = polar(a0, R_MAX), [bx, by] = polar(a1, R_MAX)
    return (
      <path key={i} d={`M${CX} ${CY} L${ax.toFixed(1)} ${ay.toFixed(1)} A${R_MAX} ${R_MAX} 0 0 0 ${bx.toFixed(1)} ${by.toFixed(1)} Z`}
            fill={INSTRUMENT.gold} opacity={0.16 * (1 - i / 26) ** 1.7} />
    )
  })

  // ── arcs: the Geo Map's own resolved styling, run as chords ──────────────
  const endpoint = (ip: string, lat: number, lng: number) => {
    const hit = byKey.get(locKey(ip, lat, lng))
    if (hit) return [hit.x, hit.y] as [number, number]
    const d = haversine(origin, { lat, lng })
    return polar(d < 1 ? 0 : bearing(origin, { lat, lng }), rangeR(d))
  }

  const arcPaths = view.arcs.map((arc: GeoArc, i: number) => {
    const [x1, y1] = endpoint(arc.src_ip, arc.src_lat, arc.src_lng)
    const [x2, y2] = endpoint(arc.dst_ip, arc.dst_lat, arc.dst_lng)
    if (Math.hypot(x2 - x1, y2 - y1) < 1.5) return null
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
    let cx: number, cy: number
    if (Math.hypot(mx - CX, my - CY) < 10) {
      // Chord passes through the origin — bow it sideways instead, or the
      // control point is undefined and the curve collapses to a straight line.
      const nx = -(y2 - y1), ny = x2 - x1, len = Math.hypot(nx, ny) || 1
      cx = mx + (nx / len) * 46; cy = my + (ny / len) * 46
    } else {
      cx = CX + (mx - CX) * 1.22; cy = CY + (my - CY) * 1.22
    }
    return (
      <path key={i}
            d={`M${x1.toFixed(1)} ${y1.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`}
            fill="none" stroke={arc.color} strokeWidth={1.1 / k} opacity={0.55}
            strokeDasharray={scaleDash(arc.dash, k)}
            style={{ cursor: 'pointer' }}
            onClick={() => { if (!suppressClick.current) window.location.href = `/explorer?src_ip=${arc.src_ip}&dst_ip=${arc.dst_ip}` }}>
        <title>{`${arc.label ?? 'Unmatched'} — ${arc.src_ip} ↔ ${arc.dst_ip} · ${fmtBytes(arc.bytes)} · ${fmtNum(arc.flows)} flows`}</title>
      </path>
    )
  })

  // ── legend: same three groups, scoped to what's on the face right now ────
  const usedArcs: GeoArc[] = []
  const seenLabels = new Set<string>()
  for (const a of geoData.arcs) {
    if (!a.label || seenLabels.has(a.label)) continue
    seenLabels.add(a.label); usedArcs.push(a)
  }
  const presentSiteKeys = new Set(geoData.locations.map(l => l.site_key).filter(Boolean))
  const legendSites = config.sites.filter(s => s.show_in_legend && presentSiteKeys.has(s.name))
  const presentMappings = new Set(geoData.locations.map(l => l.site_name).filter(Boolean))
  const legendMappings = config.natMappings.filter(m => m.show_in_legend && presentMappings.has(m.name))

  const row = (on: boolean, onClick: () => void, swatch: JSX.Element, label: string) => (
    <button key={label} type="button" onClick={onClick}
            className={`flex items-center gap-2 w-full text-left px-1 -mx-1 py-[1px] rounded transition-colors
                        ${on ? 'bg-blue-500/20 text-white' : 'text-gray-400 hover:text-white hover:bg-blue-500/10'}`}>
      {swatch}<span className="truncate">{label}</span>
    </button>
  )

  const totals = contacts.reduce(
    (acc, c) => ({ bytes: acc.bytes + c.loc.bytes, flows: acc.flows + c.loc.flows }),
    { bytes: 0, flows: 0 },
  )

  return (
    <div ref={wrapRef}
         className={`absolute inset-0 ${zoomable ? (k > 1 ? 'cursor-grab active:cursor-grabbing' : '') : ''}`}
         onMouseLeave={() => setHover(null)}
         onPointerDown={e => {
           if (!zoomable || k === 1) return
           suppressClick.current = false
           dragRef.current = { cx: e.clientX, cy: e.clientY, moved: false }
         }}
         onPointerMove={e => {
           const d = dragRef.current, el = wrapRef.current
           if (!d || !el) return
           const rect = el.getBoundingClientRect()
           const scale = Math.min(rect.width, rect.height) / VB
           const dx = (e.clientX - d.cx) / scale, dy = (e.clientY - d.cy) / scale
           if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true
           d.cx = e.clientX; d.cy = e.clientY
           setZoom(z => clampPan({ k: z.k, tx: z.tx + dx, ty: z.ty + dy }))
         }}
         onPointerUp={() => { suppressClick.current = dragRef.current?.moved ?? false; dragRef.current = null }}
         onPointerCancel={() => { dragRef.current = null }}>
      <style>{`
        @keyframes pf-radar-spin { to { transform: rotate(360deg); } }
        @keyframes pf-radar-phos { 0% { opacity: 1 } 6% { opacity: .92 } 55% { opacity: .46 } 100% { opacity: .38 } }
        .pf-radar-sweep { transform-origin: ${CX}px ${CY}px; animation: pf-radar-spin 7s linear infinite; }
        .pf-radar-blip  { animation: pf-radar-phos 7s linear infinite; }
        @media (prefers-reduced-motion: reduce) {
          .pf-radar-sweep { animation: none; opacity: .3; }
          .pf-radar-blip  { animation: none; opacity: .92; }
        }
      `}</style>

      <svg width="100%" height="100%" viewBox={`0 0 ${VB} ${VB}`}
           preserveAspectRatio="xMidYMid meet"
           role="img" aria-label="Traffic radar — endpoints by bearing and range from your sites">
      <g transform={k === 1
          ? undefined
          : `translate(${zoom.tx.toFixed(2)} ${zoom.ty.toFixed(2)}) translate(${CX} ${CY}) scale(${k}) translate(${-CX} ${-CY})`}>
        {/* range rings */}
        <circle cx={CX} cy={CY} r={R_MAX} fill="none" stroke="rgba(216,180,110,.28)" strokeWidth={1 / k} />
        {RINGS.map(km => {
          const r = rangeR(km)
          return (
            <g key={km}>
              <circle cx={CX} cy={CY} r={r} fill="none" stroke="rgba(216,180,110,.16)"
                      strokeWidth={1 / k} strokeDasharray={scaleDash('1 5', k)} />
              <text x={CX + 4 / k} y={CY - r + 11 / k}
                    fontFamily="ui-monospace, SF Mono, Menlo, monospace" fontSize={8.5 / k}
                    letterSpacing={1.4 / k} fill={INSTRUMENT.inkDim} opacity={0.8}>
                {km >= 1000 ? `${km / 1000}K` : km} KM
              </text>
            </g>
          )
        })}
        {spokes}

        <g className="pf-radar-sweep" aria-hidden="true">
          {trail}
          <line x1={CX} y1={CY} x2={CX} y2={CY - R_MAX} stroke={INSTRUMENT.goldHi} strokeWidth={1 / k} opacity={0.55} />
        </g>

        {arcPaths}

        {/* origin — the centroid of your mapped sites */}
        <circle cx={CX} cy={CY} r={16 / k} fill="none" stroke="rgba(216,180,110,.22)" strokeWidth={1 / k} />
        <circle cx={CX} cy={CY} r={4.2 / k} fill={INSTRUMENT.goldHi} style={{ filter: 'drop-shadow(0 0 6px #d8b46e)' }} />
        <text x={CX} y={CY + 29 / k} textAnchor="middle"
              fontFamily="ui-monospace, SF Mono, Menlo, monospace" fontSize={8 / k}
              letterSpacing={2 / k} fill={INSTRUMENT.gold} opacity={0.85}>ORIGIN</text>

        {contacts.map(c => (
          <g key={c.key} style={{ cursor: 'pointer' }}
             onMouseMove={e => onMove(e, c)}
             onMouseLeave={() => setHover(null)}
             onClick={() => { if (!suppressClick.current) window.location.href = `/explorer?src_ip=${c.loc.ip}` }}>
            <circle className="pf-radar-blip" cx={c.x} cy={c.y} r={c.halo / k} fill="none"
                    stroke={c.stroke} strokeWidth={0.8 / k} opacity={0.5}
                    style={{ animationDelay: `${-(c.brg / 360) * 7}s` }} />
            <circle className="pf-radar-blip" cx={c.x} cy={c.y} r={c.r / k} fill={c.fill} fillOpacity={0.82}
                    stroke={c.stroke} strokeWidth={(hover?.c.key === c.key ? 2.6 : 1.2) / k}
                    style={{ animationDelay: `${-(c.brg / 360) * 7}s`, filter: `drop-shadow(0 0 5px ${c.fill}77)` }} />
            <circle cx={c.x} cy={c.y} r={(c.halo + 9) / k} fill="transparent" />
            {/* Suppressed inside the first ring band, where labels would pile
                onto the ORIGIN caption — the test is on-screen distance, so
                zooming in is what reveals the home cluster's names. */}
            {labelled.has(c.key) && Math.hypot(c.x - CX, c.y - CY) * k > 72 && (
              <text x={c.x + (c.halo + 5) / k} y={c.y + 3 / k}
                    fontFamily="ui-monospace, SF Mono, Menlo, monospace" fontSize={8.5 / k}
                    letterSpacing={0.6 / k} fill={INSTRUMENT.ink} opacity={0.72}>
                {c.loc.city || c.loc.ip}
              </text>
            )}
          </g>
        ))}
      </g>
      </svg>

      {/* scope tags */}
      <div className="absolute top-2 left-2.5 text-[9px] font-mono uppercase tracking-[0.22em] text-gray-500 pointer-events-none">
        PPI · north up · log range
      </div>
      {!compact && (
        <div className="absolute bottom-2 right-2.5 text-[9px] font-mono uppercase tracking-[0.18em] text-gray-500 pointer-events-none">
          {contacts.length} contacts · {fmtBytes(totals.bytes)} · {fmtNum(totals.flows)} flows
        </div>
      )}

      {/* zoom — page only; the dashboard card stays a fixed face */}
      {zoomable && (
        <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
          {k > 1 && (
            <span className="text-[9px] font-mono tracking-[0.18em] text-gray-500 pointer-events-none mb-0.5">
              ×{k.toFixed(1)}
            </span>
          )}
          {([
            ['+', 'Zoom in',  () => setZoom(z => zoomAt(z, CX, CY, 1.4))],
            ['−', 'Zoom out', () => setZoom(z => zoomAt(z, CX, CY, 1 / 1.4))],
            ['⟲', 'Reset',    () => setZoom(NO_ZOOM)],
          ] as const).map(([glyph, title, fn]) => (
            <button key={title} type="button" title={title} onClick={fn}
                    disabled={glyph !== '+' && k === 1}
                    className="w-6 h-6 flex items-center justify-center rounded border border-gray-800
                               bg-gray-900/85 text-gray-400 text-xs leading-none transition-colors
                               hover:text-white hover:border-gray-600 disabled:opacity-30 disabled:hover:text-gray-400">
              {glyph}
            </button>
          ))}
        </div>
      )}

      {/* legend */}
      <div className={`absolute bottom-2 left-2 max-w-[45%] bg-gray-900/90 border border-gray-800 rounded-lg
                       px-2.5 py-2 leading-[1.6] select-none overflow-y-auto
                       ${compact ? 'text-[9.5px] max-h-[46%]' : 'text-[11px] max-h-[70%]'}`}>
        {usedArcs.length > 0 && (
          <>
            <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-gray-500 mb-0.5">Line Styles</div>
            <div className="mb-1.5">
              {usedArcs.map(a => row(
                selection.lines.has(a.label!),
                () => toggle('lines', a.label!),
                <svg width="26" height="7" className="flex-shrink-0" aria-hidden="true">
                  <line x1="0" y1="3.5" x2="26" y2="3.5" stroke={a.color} strokeWidth="2"
                        strokeDasharray={a.dash || undefined} />
                </svg>,
                a.label!,
              ))}
            </div>
          </>
        )}
        {legendSites.length > 0 && (
          <>
            <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-gray-500 mb-0.5">Sites</div>
            <div className="mb-1.5">
              {legendSites.map(s => row(
                selection.sites.has(s.name),
                () => toggle('sites', s.name),
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ background: s.fill_color, border: `1.5px solid ${s.stroke_color}` }} />,
                s.display_name,
              ))}
            </div>
          </>
        )}
        {legendMappings.length > 0 && (
          <>
            <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-gray-500 mb-0.5">NAT Mappings</div>
            <div>
              {legendMappings.map(m => {
                const site = config.sites.find(s => s.name === m.site_key)
                return row(
                  selection.mappings.has(m.name),
                  () => toggle('mappings', m.name),
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{
                          background: site?.fill_color ?? config.defaultFill,
                          border: `1.5px solid ${site?.stroke_color ?? config.defaultStroke}`,
                        }} />,
                  m.name,
                )
              })}
            </div>
          </>
        )}
        {hasSelection(selection) && (
          <button type="button" onClick={() => setSelection(EMPTY_SELECTION)}
                  className="mt-1.5 w-full text-center text-[9px] uppercase tracking-[0.18em] py-0.5
                             border border-gray-800 rounded text-gray-500 hover:text-white hover:border-gray-600 transition-colors">
            Reset
          </button>
        )}
      </div>

      {/* contact readout */}
      {hover && (
        <div className="absolute z-20 pointer-events-none bg-gray-900/97 border border-gray-700 rounded px-2.5 py-2
                        text-[10.5px] font-mono leading-[1.6] whitespace-nowrap"
             style={{
               left: Math.min(hover.x + 14, (wrapRef.current?.clientWidth ?? 0) - 220),
               top:  Math.min(hover.y + 14, (wrapRef.current?.clientHeight ?? 0) - 130),
             }}>
          <div className="text-white">{hover.c.loc.ip}</div>
          <div><span className="inline-block w-14 text-gray-500">Location</span>
            {[hover.c.loc.city, hover.c.loc.country].filter(Boolean).join(' · ') || 'unknown'}</div>
          {hover.c.loc.site_name && (
            <div><span className="inline-block w-14 text-gray-500">Site</span>{hover.c.loc.site_name}</div>
          )}
          <div><span className="inline-block w-14 text-gray-500">Bearing</span>{brgLabel(hover.c.brg)}</div>
          <div><span className="inline-block w-14 text-gray-500">Range</span>{fmtKm(hover.c.dist)}</div>
          <div><span className="inline-block w-14 text-gray-500">Bytes</span>{fmtBytes(hover.c.loc.bytes)}</div>
          <div><span className="inline-block w-14 text-gray-500">Flows</span>{fmtNum(hover.c.loc.flows)}</div>
        </div>
      )}
    </div>
  )
}

// ── Shared data plumbing ───────────────────────────────────────────────────
function useRadarData(timeWindow: string) {
  const [geoData, setGeoData] = useState<GeoDataResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(false)
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

  return { geoData, loading, error, load }
}

function RadarBody({
  geoData, config, loading, error, timeWindow, compact, zoomable,
}: {
  geoData: GeoDataResponse | null
  config: GeoConfig | null
  loading: boolean
  error: boolean
  timeWindow: string
  compact?: boolean
  zoomable?: boolean
}) {
  const hasData = geoData && geoData.locations.length > 0
  const size = compact ? 'text-xs' : 'text-sm'
  if (error) return <div className={`absolute inset-0 flex items-center justify-center ${size} text-gray-500`}>Geo lookup unavailable — check network connectivity</div>
  if (!loading && geoData && !hasData) return <div className={`absolute inset-0 flex items-center justify-center ${size} text-gray-500`}>No external IP traffic in the {timeWindow} window</div>
  if (hasData && config) return <RadarScope geoData={geoData!} config={config} compact={compact} zoomable={zoomable} />
  return null
}

// ── RadarCard — inline card for the Analytics dashboard ────────────────────
export function RadarCard({ timeWindow }: { timeWindow: string }) {
  const { geoData, loading, error, load } = useRadarData(timeWindow)
  const config = useGeoConfig()

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 flex flex-col h-full">
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <RadarIcon size={14} className="text-blue-400" />
          Traffic Radar
        </h2>
        <div className="flex items-center gap-1">
          {loading && <span className="text-xs text-gray-500 animate-pulse mr-1">Loading…</span>}
          <button onClick={load} title="Refresh" className="p-1 rounded text-gray-500 hover:text-gray-300 transition-colors">
            <RefreshCw size={13} />
          </button>
          <button onClick={() => { window.location.href = '/radar' }} title="Open the full Radar page"
                  className="p-1 rounded text-gray-500 hover:text-gray-300 transition-colors">
            <Maximize2 size={13} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 relative rounded-lg overflow-hidden">
        <RadarBody geoData={geoData} config={config} loading={loading} error={error}
                   timeWindow={timeWindow} compact />
      </div>
    </div>
  )
}

// ── RadarPage — full nav page at /radar ────────────────────────────────────
export default function RadarPage() {
  const [timeWindow, setTimeWindow] = useState('1h')
  const { geoData, loading, error, load } = useRadarData(timeWindow)
  const config = useGeoConfig()

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold text-white">Radar</h1>
          <HelpButton title="Radar — How It Works">
            <p>The same traffic the Geo Map plots, drawn as a plan-position scope. The <span className="text-gray-300 font-medium">origin</span> is the centre of your own mapped network — the spherical centroid of every location placed by <span className="text-gray-300 font-medium">Settings → Geo Map</span> (NAT Mappings and Sites). With nothing mapped yet, it falls back to the centre of all observed traffic.</p>
            <p><span className="text-gray-300 font-medium">Bearing</span> is the true initial bearing from that origin, north up. <span className="text-gray-300 font-medium">Range</span> is great-circle distance on a log scale, so a 300 km hop and a 17 000 km hop are both readable on one face; the dotted rings are labelled in km. Blip size is bytes, the outer halo is flow count, and blip colour is the endpoint's Site colour. Arcs keep the colour and dash your Traffic Rules resolved for them.</p>
            <p>Two endpoints that land on the same spot are stacked outward along their own bearing, each clearing the one before it, so direction always stays true and only range shifts slightly.</p>
            <p><span className="text-gray-300 font-medium">Zoom</span> with the scroll wheel (or the buttons top-right), drag to pan, <span className="text-gray-300 font-medium">⟲</span> to reset. Blips and labels keep their size as you zoom, so zooming spreads contacts apart rather than magnifying them — and the home cluster's names appear once there's room for them. The dashboard card is a fixed face with no zoom.</p>
            <p><span className="text-gray-300 font-medium">The legend is clickable</span> — Line Style, Site or NAT Mapping filters the face to that item and everything connected to it, exactly as on the Geo Map. Click a blip to open Flow Explorer for that address; click an arc to open the conversation.</p>
          </HelpButton>
        </div>
        <div className="flex items-center gap-3">
          {loading && <span className="text-xs text-gray-400 animate-pulse">Loading…</span>}
          <button onClick={load} title="Refresh" className="p-1.5 rounded text-gray-400 hover:text-white transition-colors">
            <RefreshCw size={14} />
          </button>
          <div className="flex bg-gray-800 rounded-lg p-0.5 gap-0.5">
            {WINDOWS.map(w => (
              <button key={w} onClick={() => setTimeWindow(w)}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                        timeWindow === w ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                {w}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 relative bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <RadarBody geoData={geoData} config={config} loading={loading} error={error} timeWindow={timeWindow} zoomable />
      </div>
    </div>
  )
}
