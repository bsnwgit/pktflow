/**
 * Geo data plumbing shared by the Geo Map and the Radar.
 *
 * Both surfaces read the same /flows/geo payload, colour it from the same
 * Sites / NAT Mappings config, and offer the same clickable legend filter —
 * so the config hook and the filter live here rather than in either page.
 * Keeping them out of GeoMap.tsx also keeps Leaflet and d3 out of anything
 * that only needs the data (the dashboard's Radar card pulled in the whole
 * 170 kB map chunk when these lived there).
 */
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { useAutoRefresh } from '../store/autoRefresh'
import type { GeoDataResponse, Site, NatMapping } from '../api/client'

// ── Geo config (dynamic — fetched from API, falls back to hardcoded defaults) ──
// Line style info no longer lives here — arcs already carry their resolved
// color/dash/label from the backend (see GeoArc), so the legend reads
// straight off geoData.arcs instead of a separately-fetched catalog.
export interface GeoConfig {
  siteColors:   Record<string, string>
  siteStrokes:  Record<string, string>
  defaultFill:  string
  defaultStroke: string
  sites:        Site[]
  natMappings:  NatMapping[]
}

const FALLBACK_CONFIG: GeoConfig = {
  siteColors:  { group_a: '#b0a0dd', group_b: '#9aeabd' },
  siteStrokes: { group_a: '#c4b7e9', group_b: '#9aeabd' },
  defaultFill:  '#ff6b5e',
  defaultStroke: '#ff9086',
  sites:        [],
  natMappings:  [],
}

function buildConfig(sites: Site[], natMappings: NatMapping[]): GeoConfig {
  let defaultFill   = '#8ad8ea'
  let defaultStroke = '#63c3d8'

  const siteColors:  Record<string, string> = {}
  const siteStrokes: Record<string, string> = {}
  for (const s of sites) {
    siteColors[s.name]  = s.fill_color
    siteStrokes[s.name] = s.stroke_color
  }

  // External marker colour: fall back to red if no 'external' site is configured
  const extSite = sites.find(s => s.name === 'external') ?? null
  if (extSite) {
    defaultFill   = extSite.fill_color
    defaultStroke = extSite.stroke_color
  }

  return { siteColors, siteStrokes, defaultFill, defaultStroke, sites, natMappings }
}

// Fetched fresh on every mount and on every auto-refresh tick — a prior
// version cached this at module scope for the whole browser session, which
// meant editing Sites (e.g. unchecking "show in legend") in Settings never
// showed up on the Geo Map without a hard page reload.
export function useGeoConfig(): GeoConfig | null {
  const [config, setConfig] = useState<GeoConfig | null>(null)
  const { tick } = useAutoRefresh()
  useEffect(() => {
    Promise.all([api.getSites(), api.getNatMappings()])
      .then(([sites, natMappings]) => setConfig(buildConfig(sites, natMappings)))
      .catch(() => setConfig(FALLBACK_CONFIG))
  }, [tick])
  return config
}

// ── Legend selection (clickable filter state) ─────────────────────────────
// lines/sites/mappings hold the currently-toggled-on keys for each legend
// category — arc.label for lines, site.name for sites, mapping.name for
// mappings. Empty everywhere = no filter, show all traffic (the default).
export interface LegendSelection {
  lines: Set<string>
  sites: Set<string>
  mappings: Set<string>
}
export const EMPTY_SELECTION: LegendSelection = { lines: new Set(), sites: new Set(), mappings: new Set() }
export function hasSelection(sel: LegendSelection): boolean {
  return sel.lines.size > 0 || sel.sites.size > 0 || sel.mappings.size > 0
}

// ── Legend filtering ───────────────────────────────────────────────────────
// A location's key is (ip, lat, lng) rather than just ip — the same private
// IP can produce two separate location entries with different site/lat/lng
// when its NAT mapping's own dst_cidrs/dst_ports make it resolve differently
// by destination (see app/api/flows.py). Keying on ip alone would collapse
// those into one and mismatch which entry an arc's endpoint actually is.
export function locKey(ip: string, lat: number, lng: number): string {
  return `${ip}|${lat}|${lng}`
}

export function filterGeoData(geoData: GeoDataResponse, selection: LegendSelection): GeoDataResponse {
  if (!hasSelection(selection)) return geoData

  const locByKey = new Map(geoData.locations.map(l => [locKey(l.ip, l.lat, l.lng), l]))
  const matches = (ip: string, lat: number, lng: number): boolean => {
    const loc = locByKey.get(locKey(ip, lat, lng))
    if (!loc) return false
    return (!!loc.site_key && selection.sites.has(loc.site_key)) ||
           (!!loc.site_name && selection.mappings.has(loc.site_name))
  }

  const visibleArcs = geoData.arcs.filter(arc =>
    (!!arc.label && selection.lines.has(arc.label)) ||
    matches(arc.src_ip, arc.src_lat, arc.src_lng) ||
    matches(arc.dst_ip, arc.dst_lat, arc.dst_lng)
  )

  // Both endpoints of any visible arc must render even if the far side
  // wasn't itself part of the selection — an arc can't draw with only one
  // end showing. Also directly include any location matching the selection
  // on its own, in case it has no arc for some reason.
  const visibleKeys = new Set<string>()
  for (const arc of visibleArcs) {
    visibleKeys.add(locKey(arc.src_ip, arc.src_lat, arc.src_lng))
    visibleKeys.add(locKey(arc.dst_ip, arc.dst_lat, arc.dst_lng))
  }
  for (const loc of geoData.locations) {
    if (matches(loc.ip, loc.lat, loc.lng)) visibleKeys.add(locKey(loc.ip, loc.lat, loc.lng))
  }

  return {
    locations: geoData.locations.filter(l => visibleKeys.has(locKey(l.ip, l.lat, l.lng))),
    arcs: visibleArcs,
  }
}
