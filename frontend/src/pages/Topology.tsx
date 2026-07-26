/**
 * Network Topology page — D3 force-directed graph of IP communication pairs.
 * Nodes = IP addresses; edges = aggregated flows between them.
 * Node size  ∝ total bytes.  Edge width ∝ bytes.  Color = site.
 */
import { useEffect, useRef, useState, useCallback, RefObject } from 'react'
import * as d3 from 'd3'
import { useNavigate } from 'react-router-dom'
import { api, TopologyNode, TopologyEdge, DeviceSummary } from '../api/client'
import { protoShort } from '../utils/protocols'
import IpLink from '../components/IpLink'
import HelpButton from '../components/HelpButton'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB'
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB'
  return b + ' B'
}

const SITE_COLORS = [
  '#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4',
]

function siteColorFn(nodes: TopologyNode[]): (site: string) => string {
  const sites = Array.from(new Set(nodes.map(n => n.site || 'unknown')))
  return (s: string) => SITE_COLORS[sites.indexOf(s) % SITE_COLORS.length]
}

function attachTooltip() {
  const tip = d3.select('body').append('div')
    .style('position', 'fixed').style('background', '#111827')
    .style('border', '1px solid #374151').style('border-radius', '8px')
    .style('padding', '8px 12px').style('font-size', '12px')
    .style('color', '#f3f4f6').style('pointer-events', 'none')
    .style('opacity', '0').style('z-index', '9999')
    .style('max-width', '260px').style('line-height', '1.6')
  const show = (_ev: MouseEvent, html: string) => tip.style('opacity', '1').html(html)
  const move = (ev: MouseEvent) => tip.style('left', ev.clientX + 14 + 'px').style('top', ev.clientY - 10 + 'px')
  const hide = () => tip.style('opacity', '0')
  return { tip, show, move, hide }
}

function renderSiteLegend(
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
  sites: string[],
  siteColor: (s: string) => string,
) {
  const legend = svg.append('g').attr('transform', 'translate(12,12)')
  sites.slice(0, 8).forEach((site, i) => {
    const row = legend.append('g').attr('transform', `translate(0,${i * 18})`)
    row.append('circle').attr('r', 5).attr('cx', 5).attr('cy', 5).attr('fill', siteColor(site))
    row.append('text').text(site).attr('x', 14).attr('y', 9)
      .attr('fill', '#9ca3af').attr('font-size', '10px')
  })
}

function truncateLabel(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// ── D3 Graph ──────────────────────────────────────────────────────────────────

interface D3Node extends TopologyNode {
  x?: number; y?: number; fx?: number | null; fy?: number | null
  _id: string
}

interface D3Link extends d3.SimulationLinkDatum<D3Node> {
  bytes: number; flows: number; protocol: number; dst_port: number
}

function ForceGraph({
  svgRef,
  data,
  onNodeClick,
  width,
  height,
}: {
  svgRef: RefObject<SVGSVGElement>
  data: { nodes: TopologyNode[]; edges: TopologyEdge[] }
  onNodeClick: (node: TopologyNode) => void
  width: number
  height: number
}) {
  useEffect(() => {
    if (!svgRef.current || !data.nodes.length) return

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const sites = Array.from(new Set(data.nodes.map(n => n.site || 'unknown')))
    const siteColor = siteColorFn(data.nodes)

    const maxBytes     = Math.max(...data.nodes.map(n => n.bytes), 1)
    const maxEdgeBytes = Math.max(...data.edges.map(e => e.bytes), 1)
    const rScale = d3.scaleSqrt().domain([0, maxBytes]).range([5, 28])
    const wScale = d3.scaleSqrt().domain([0, maxEdgeBytes]).range([1, 8])

    const nodeMap = new Map<string, D3Node>()
    const nodes: D3Node[] = data.nodes.map(n => {
      const d: D3Node = { ...n, _id: n.id }
      nodeMap.set(n.id, d)
      return d
    })

    const links: D3Link[] = data.edges
      .filter(e => nodeMap.has(e.source as string) && nodeMap.has(e.target as string))
      .map(e => ({
        source: e.source as string,
        target: e.target as string,
        bytes: e.bytes, flows: e.flows,
        protocol: e.protocol, dst_port: e.dst_port,
      }))

    const g = svg.append('g')

    svg.call(
      d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.08, 10])
        .on('zoom', ev => g.attr('transform', ev.transform))
    )

    svg.append('defs').append('marker')
      .attr('id', 'arr')
      .attr('viewBox', '0 -4 8 8').attr('refX', 22).attr('refY', 0)
      .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', '#4b5563')

    // ── Cluster hulls ─────────────────────────────────────────────────────────
    const HULL_PADDING = 32

    const siteNodes = new Map<string, D3Node[]>()
    nodes.forEach(n => {
      const s = n.site || 'unknown'
      if (!siteNodes.has(s)) siteNodes.set(s, [])
      siteNodes.get(s)!.push(n)
    })
    const activeSites = [...siteNodes.entries()].filter(([, ns]) => ns.length >= 2)

    const hullGroup = g.append('g').attr('class', 'hulls')
    const hullLabelGroup = g.append('g').attr('class', 'hull-labels')

    const hullLine = d3.line<[number, number]>()
      .x(p => p[0]).y(p => p[1])
      .curve(d3.curveCatmullRomClosed)

    function computeHullPath(pts: [number, number][], padding: number): string {
      if (pts.length < 2) return ''
      let shapePts: [number, number][]
      if (pts.length === 2) {
        const [p0, p1] = pts
        const angle = Math.atan2(p1[1] - p0[1], p1[0] - p0[0])
        const steps = 12
        const cap: [number, number][] = []
        for (let i = 0; i <= steps; i++) {
          const a = angle + Math.PI / 2 + (Math.PI * i / steps)
          cap.push([p0[0] + Math.cos(a) * padding, p0[1] + Math.sin(a) * padding])
        }
        for (let i = 0; i <= steps; i++) {
          const a = angle - Math.PI / 2 + (Math.PI * i / steps)
          cap.push([p1[0] + Math.cos(a) * padding, p1[1] + Math.sin(a) * padding])
        }
        shapePts = cap
      } else {
        const hull = d3.polygonHull(pts)
        if (!hull) return ''
        const cx = d3.mean(hull, p => p[0])!
        const cy = d3.mean(hull, p => p[1])!
        shapePts = hull.map(p => {
          const dx = p[0] - cx, dy = p[1] - cy
          const len = Math.sqrt(dx * dx + dy * dy) || 1
          return [p[0] + dx / len * padding, p[1] + dy / len * padding] as [number, number]
        })
      }
      return hullLine(shapePts) ?? ''
    }

    const hullPaths = new Map<string, d3.Selection<SVGPathElement, unknown, null, undefined>>()
    const hullTexts = new Map<string, d3.Selection<SVGTextElement, unknown, null, undefined>>()
    const hullBgs   = new Map<string, d3.Selection<SVGRectElement, unknown, null, undefined>>()
    activeSites.forEach(([site]) => {
      const color = siteColor(site)
      hullPaths.set(site,
        hullGroup.append('path')
          .attr('fill', color).attr('fill-opacity', 0.11)
          .attr('stroke', color).attr('stroke-opacity', 0.55)
          .attr('stroke-width', 1.5).attr('stroke-dasharray', '5,3')
      )
      hullBgs.set(site,
        hullLabelGroup.append('rect')
          .attr('fill', '#111827').attr('fill-opacity', 0.65)
          .attr('rx', 4).attr('ry', 4)
          .attr('pointer-events', 'none')
      )
      hullTexts.set(site,
        hullLabelGroup.append('text')
          .text(site.toUpperCase())
          .attr('fill', color).attr('fill-opacity', 0.9)
          .attr('font-size', '12px').attr('font-weight', '700')
          .attr('text-anchor', 'middle').attr('pointer-events', 'none')
          .attr('letter-spacing', '0.1em')
      )
    })

    function updateHulls() {
      activeSites.forEach(([site, sNodes]) => {
        const pts = sNodes.map(n => [n.x ?? 0, n.y ?? 0] as [number, number])
        hullPaths.get(site)!.attr('d', computeHullPath(pts, HULL_PADDING))
        const cx = d3.mean(pts, p => p[0])!
        const cy = d3.mean(pts, p => p[1])!
        const txt = hullTexts.get(site)!.attr('x', cx).attr('y', cy + 4)
        const tNode = txt.node()
        if (tNode) {
          const bb = (tNode as SVGTextElement).getBBox?.()
          if (bb && bb.width > 0) {
            hullBgs.get(site)!
              .attr('x', cx - bb.width / 2 - 5)
              .attr('y', cy - bb.height + 1)
              .attr('width', bb.width + 10)
              .attr('height', bb.height + 2)
          }
        }
      })
      hullLabelGroup.raise()
    }

    // ── Links ─────────────────────────────────────────────────────────────────
    // Asymmetric edges (one side sent >10× the other) render in amber as a visual flag
    const link = g.append('g').selectAll<SVGLineElement, D3Link>('line')
      .data(links).join('line')
      .attr('stroke', d => (d as any).is_asymmetric ? '#f59e0b' : '#374151')
      .attr('stroke-width', d => wScale(d.bytes))
      .attr('stroke-opacity', d => (d as any).is_asymmetric ? 0.85 : 0.7)
      .attr('marker-end', 'url(#arr)')

    const node = g.append('g').selectAll<SVGGElement, D3Node>('g')
      .data(nodes).join('g')
      .attr('cursor', 'pointer')
      .call(
        d3.drag<SVGGElement, D3Node>()
          .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y })
          .on('drag',  (ev, d) => { d.fx = ev.x; d.fy = ev.y })
          .on('end',   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null })
      )
      .on('click', (_, d) => onNodeClick(d))

    node.append('circle')
      .attr('r', d => rScale(d.bytes))
      .attr('fill', d => siteColor(d.site || 'unknown'))
      .attr('fill-opacity', 0.85)
      .attr('stroke', d => d.is_sampler ? '#fff' : 'rgba(255,255,255,0.15)')
      .attr('stroke-width', d => d.is_sampler ? 2.5 : 0.5)

    node.filter(d => d.is_sampler).append('circle')
      .attr('r', 3).attr('fill', '#fff').attr('fill-opacity', 0.9)

    const labelThreshold = d3.quantile(
      nodes.map(n => n.bytes).sort(d3.ascending), 0.75
    ) ?? 0
    node.filter(d => d.is_sampler || d.bytes >= labelThreshold)
      .append('text')
      .text(d => d.sampler_name || d.id)
      .attr('dy', d => -rScale(d.bytes) - 5)
      .attr('text-anchor', 'middle')
      .attr('fill', '#d1d5db').attr('font-size', '10px')
      .attr('pointer-events', 'none')

    // Tooltip
    const { tip, show: showTip, move: moveTip, hide: hideTip } = attachTooltip()

    node
      .on('mouseenter', (ev, d) => showTip(ev, `
        <b>${d.sampler_name || d.id}</b>
        ${d.site ? `<br><span style="color:#9ca3af">Site: ${d.site}</span>` : ''}
        <br>Bytes: ${fmtBytes(d.bytes)}
        <br>Flows: ${d.flows.toLocaleString()}
        ${d.is_sampler ? '<br><span style="color:#60a5fa">★ NetFlow sampler</span>' : ''}
      `))
      .on('mousemove', moveTip).on('mouseleave', hideTip)

    link
      .on('mouseenter', (ev, d) => {
        const src = typeof d.source === 'string' ? d.source : (d.source as D3Node)._id
        const dst = typeof d.target === 'string' ? d.target : (d.target as D3Node)._id
        const fwd = (d as any).bytes_fwd ?? 0
        const rev = (d as any).bytes_rev ?? 0
        const asymFlag = (d as any).is_asymmetric
          ? `<br><span style="color:#f59e0b">⚠ Asymmetric — ${fwd > rev ? src : dst} sent ${fwd > rev ? (fwd/Math.max(rev,1)).toFixed(0) : (rev/Math.max(fwd,1)).toFixed(0)}× more</span>`
          : ''
        showTip(ev, `
          <b>${src} ↔ ${dst}</b>
          <br>Total: ${fmtBytes(d.bytes)} · ${d.flows.toLocaleString()} flows
          ${fwd || rev ? `<br>→ ${fmtBytes(fwd)} &nbsp; ← ${fmtBytes(rev)}` : ''}
          <br><span style="color:#9ca3af">${protoShort(d.protocol)}${d.dst_port ? `:${d.dst_port}` : ''}</span>
          ${asymFlag}
        `)
      })
      .on('mousemove', moveTip).on('mouseleave', hideTip)

    // Site target positions
    const siteList = [...siteNodes.keys()]
    const siteTargets = new Map<string, { x: number; y: number }>()
    siteList.forEach((site, i) => {
      const angle = (i / siteList.length) * 2 * Math.PI - Math.PI / 2
      const r = Math.min(width, height) * 0.28
      siteTargets.set(site, {
        x: width / 2 + Math.cos(angle) * r,
        y: height / 2 + Math.sin(angle) * r,
      })
    })

    const sim = d3.forceSimulation<D3Node>(nodes)
      .force('link', d3.forceLink<D3Node, D3Link>(links)
        .id(d => d._id)
        .distance(d => 60 + Math.sqrt(d.bytes / maxEdgeBytes) * 100)
        .strength(0.4))
      .force('charge', d3.forceManyBody<D3Node>().strength(d => -120 - rScale(d.bytes) * 5))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide<D3Node>().radius(d => rScale(d.bytes) + 8))
      .force('site-x', d3.forceX<D3Node>(d => siteTargets.get(d.site || 'unknown')?.x ?? width / 2).strength(0.06))
      .force('site-y', d3.forceY<D3Node>(d => siteTargets.get(d.site || 'unknown')?.y ?? height / 2).strength(0.06))

    sim.on('tick', () => {
      updateHulls()
      link
        .attr('x1', d => (d.source as D3Node).x ?? 0)
        .attr('y1', d => (d.source as D3Node).y ?? 0)
        .attr('x2', d => (d.target as D3Node).x ?? 0)
        .attr('y2', d => (d.target as D3Node).y ?? 0)
      node.attr('transform', d => `translate(${d.x ?? 0},${d.y ?? 0})`)
    })

    // Legend
    renderSiteLegend(svg, sites, siteColor)

    return () => { sim.stop(); tip.remove() }
  }, [data, width, height, onNodeClick, svgRef])

  return <svg ref={svgRef} width={width} height={height} />
}

// ── Hierarchical Graph ───────────────────────────────────────────────────────
//
// Fixed 3-band diagram per sampler, not a recursive tree: private devices
// (grouped into labeled subnet boxes) at top, one generic "L3" pivot node
// per sampler in the middle (no IP or stats shown — it represents the
// network boundary itself, not a specific guessed router), external
// destinations at bottom. Every private device gets exactly one line up
// into L3; every external gets exactly one line down from L3 — so a
// destination reached by five different internal hosts still renders once,
// with five lines converging on it, never duplicated or chained through
// each other. Private<->private traffic draws as a direct dashed line
// beside the bands, since it never actually crosses the L3 boundary.

// Pure IP-address classification — no lookback at traffic history, no
// per-deployment configuration. Works identically on any network: private
// (RFC 1918 + loopback + link-local) vs. public, and /24 grouping for
// clustering same-subnet devices into their own labeled box.
function isPrivateIP(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p))) return false
  const [a, b] = parts
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  return false
}

function subnet24(ip: string): string {
  const parts = ip.split('.')
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}` : ip
}

interface LineInfo {
  peerIds: Set<string>
  bytes: number
  flows: number
}

interface SamplerBand {
  sampler: TopologyNode
  subnetGroups: { subnet: string; devices: TopologyNode[] }[]
  externals: TopologyNode[]
  privateLine: Map<string, LineInfo>    // private device id -> aggregate toward L3
  externalLine: Map<string, LineInfo>   // external device id -> aggregate from L3
  privatePrivateEdges: TopologyEdge[]   // direct edges that never cross the L3 boundary
}

function buildLayeredDiagram(nodes: TopologyNode[], edges: TopologyEdge[]): SamplerBand[] {
  const nodeById = new Map(nodes.map(n => [n.id, n]))
  const samplers = nodes.filter(n => n.is_sampler)

  return samplers.map(sampler => {
    const relevantEdges = edges.filter(e => e.sampler_ip === sampler.id)

    const privateLine = new Map<string, LineInfo>()
    const externalLine = new Map<string, LineInfo>()
    const privatePrivateEdges: TopologyEdge[] = []
    const privateIds = new Set<string>()
    const externalIds = new Set<string>()

    for (const e of relevantEdges) {
      const srcPriv = isPrivateIP(e.source)
      const dstPriv = isPrivateIP(e.target)
      if (srcPriv && dstPriv) {
        privatePrivateEdges.push(e)
        privateIds.add(e.source); privateIds.add(e.target)
        continue
      }
      if (!srcPriv && !dstPriv) continue // public<->public shouldn't occur; skip defensively

      const privId = srcPriv ? e.source : e.target
      const extId  = srcPriv ? e.target : e.source
      privateIds.add(privId); externalIds.add(extId)

      const pl = privateLine.get(privId) || { peerIds: new Set<string>(), bytes: 0, flows: 0 }
      pl.peerIds.add(extId); pl.bytes += e.bytes; pl.flows += e.flows
      privateLine.set(privId, pl)

      const el = externalLine.get(extId) || { peerIds: new Set<string>(), bytes: 0, flows: 0 }
      el.peerIds.add(privId); el.bytes += e.bytes; el.flows += e.flows
      externalLine.set(extId, el)
    }

    const privateDevices = [...privateIds].map(id => nodeById.get(id)).filter((n): n is TopologyNode => !!n)
    const externalDevices = [...externalIds].map(id => nodeById.get(id)).filter((n): n is TopologyNode => !!n)
      .sort((a, b) => b.bytes - a.bytes)

    const bySubnet = new Map<string, TopologyNode[]>()
    for (const d of privateDevices) {
      const key = subnet24(d.id)
      if (!bySubnet.has(key)) bySubnet.set(key, [])
      bySubnet.get(key)!.push(d)
    }
    const subnetGroups = [...bySubnet.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([subnet, devices]) => ({ subnet, devices: devices.sort((a, b) => b.bytes - a.bytes) }))

    return { sampler, subnetGroups, externals: externalDevices, privateLine, externalLine, privatePrivateEdges }
  })
}

// ── Layout (manual — no d3.tree; this is a fixed band diagram, not a tree) ──

const CARD_W = 172
const CARD_H = 58
const DEVICE_GAP_Y = 14
const SUBNET_PAD = 16
const SUBNET_LABEL_H = 26
const SUBNET_GAP_X = 36
const BAND_GAP_Y = 110
const L3_W = 150
const L3_H = 56
const EXTERNAL_MAX_COLS = 6
const EXTERNAL_GAP_X = 20
const EXTERNAL_GAP_Y = 16
const SAMPLER_GAP_X = 100

interface PositionedCard { node: TopologyNode; x: number; y: number; samplerId: string; kind: 'private' | 'external' }
interface LabeledBox { x: number; y: number; w: number; h: number; label: string }
interface L3Box { sampler: TopologyNode; x: number; y: number }
interface LayoutLine {
  kind: 'private-l3' | 'l3-external' | 'private-private'
  aId: string; bId: string; samplerId: string
  bytes: number; flows: number
  edge?: TopologyEdge
}
interface SamplerHeader { x: number; y: number; text: string }

interface Layout {
  cards: PositionedCard[]
  subnetBoxes: LabeledBox[]
  externalBoxes: LabeledBox[]
  l3Boxes: L3Box[]
  lines: LayoutLine[]
  headers: SamplerHeader[]
  width: number
  height: number
}

function layoutSamplerBands(bands: SamplerBand[]): Layout {
  const cards: PositionedCard[] = []
  const subnetBoxes: LabeledBox[] = []
  const externalBoxes: LabeledBox[] = []
  const l3Boxes: L3Box[] = []
  const lines: LayoutLine[] = []
  const headers: SamplerHeader[] = []

  const TOP = 44
  let cursorX = 40
  let maxBottom = 0

  for (const band of bands) {
    const samplerId = band.sampler.id
    headers.push({ x: cursorX, y: TOP - 20, text: band.sampler.sampler_name || band.sampler.id })

    let subnetX = cursorX
    let tallestSubnet = 0
    const subnetCenters: number[] = []
    for (const group of band.subnetGroups) {
      const n = group.devices.length
      const boxH = SUBNET_LABEL_H + SUBNET_PAD + n * CARD_H + Math.max(0, n - 1) * DEVICE_GAP_Y + SUBNET_PAD
      const boxW = CARD_W + SUBNET_PAD * 2
      subnetBoxes.push({ x: subnetX, y: TOP, w: boxW, h: boxH, label: group.subnet + '.0/24' })
      tallestSubnet = Math.max(tallestSubnet, boxH)
      subnetCenters.push(subnetX + boxW / 2)

      let deviceY = TOP + SUBNET_LABEL_H + SUBNET_PAD + CARD_H / 2
      for (const dev of group.devices) {
        cards.push({ node: dev, x: subnetX + boxW / 2, y: deviceY, samplerId, kind: 'private' })
        deviceY += CARD_H + DEVICE_GAP_Y
      }
      subnetX += boxW + SUBNET_GAP_X
    }
    const bandEndX = band.subnetGroups.length ? subnetX - SUBNET_GAP_X : cursorX + CARD_W
    const privateSpanCenter = subnetCenters.length
      ? (subnetCenters[0] + subnetCenters[subnetCenters.length - 1]) / 2
      : cursorX + CARD_W / 2

    const l3Y = TOP + tallestSubnet + BAND_GAP_Y / 2
    const l3X = privateSpanCenter
    l3Boxes.push({ sampler: band.sampler, x: l3X, y: l3Y })

    for (const [privId, info] of band.privateLine) {
      lines.push({ kind: 'private-l3', aId: privId, bId: samplerId, samplerId, bytes: info.bytes, flows: info.flows })
    }

    const nExt = band.externals.length
    const cols = Math.max(1, Math.min(EXTERNAL_MAX_COLS, nExt))
    const rows = nExt ? Math.ceil(nExt / cols) : 0
    const extGridW = cols * CARD_W + Math.max(0, cols - 1) * EXTERNAL_GAP_X
    const extBoxW = extGridW + SUBNET_PAD * 2
    const extBoxH = SUBNET_LABEL_H + SUBNET_PAD + rows * CARD_H + Math.max(0, rows - 1) * EXTERNAL_GAP_Y + SUBNET_PAD
    const extBoxX = l3X - extBoxW / 2
    const extBoxY = l3Y + L3_H / 2 + BAND_GAP_Y / 2
    if (nExt) externalBoxes.push({ x: extBoxX, y: extBoxY, w: extBoxW, h: extBoxH, label: 'External' })

    band.externals.forEach((dev, i) => {
      const col = i % cols, row = Math.floor(i / cols)
      const x = extBoxX + SUBNET_PAD + col * (CARD_W + EXTERNAL_GAP_X) + CARD_W / 2
      const y = extBoxY + SUBNET_LABEL_H + SUBNET_PAD + row * (CARD_H + EXTERNAL_GAP_Y) + CARD_H / 2
      cards.push({ node: dev, x, y, samplerId, kind: 'external' })
    })

    for (const [extId, info] of band.externalLine) {
      lines.push({ kind: 'l3-external', aId: samplerId, bId: extId, samplerId, bytes: info.bytes, flows: info.flows })
    }
    for (const edge of band.privatePrivateEdges) {
      lines.push({ kind: 'private-private', aId: edge.source, bId: edge.target, samplerId, bytes: edge.bytes, flows: edge.flows, edge })
    }

    maxBottom = Math.max(maxBottom, extBoxY + extBoxH, l3Y + L3_H)
    cursorX = Math.max(bandEndX, extBoxX + extBoxW) + SAMPLER_GAP_X
  }

  return { cards, subnetBoxes, externalBoxes, l3Boxes, lines, headers, width: cursorX, height: maxBottom + 40 }
}

const qualify = (samplerId: string, id: string) => `${samplerId}|${id}`
const l3Key = (samplerId: string) => `L3|${samplerId}`

function HierarchicalGraph({
  svgRef,
  data,
  width,
  height,
  window_,
}: {
  svgRef: RefObject<SVGSVGElement>
  data: { nodes: TopologyNode[]; edges: TopologyEdge[] }
  width: number
  height: number
  window_: string
}) {
  const navigate = useNavigate()

  useEffect(() => {
    if (!svgRef.current || !data.nodes.length) return

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const sites = Array.from(new Set(data.nodes.map(n => n.site || 'unknown')))
    const siteColor = siteColorFn(data.nodes)

    const bands = buildLayeredDiagram(data.nodes, data.edges)
    const bandById = new Map(bands.map(b => [b.sampler.id, b]))
    const layout = layoutSamplerBands(bands)
    if (!layout.cards.length && !layout.l3Boxes.length) return

    const maxLineBytes = Math.max(...layout.lines.map(l => l.bytes), 1)
    const wScale = d3.scaleSqrt().domain([0, maxLineBytes]).range([1, 7])

    const cardPos = new Map(layout.cards.map(c => [qualify(c.samplerId, c.node.id), c]))
    const l3Pos = new Map(layout.l3Boxes.map(l => [l.sampler.id, l]))

    const g = svg.append('g')

    const zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.08, 10])
      .on('zoom', ev => g.attr('transform', ev.transform))
    svg.call(zoomBehavior)

    // Fit the whole diagram in view on first render — horizontally centered
    // (falls back to a left padding if the diagram is wider than the
    // viewport, since there's no room to center it then), small top padding.
    const scale = Math.max(Math.min(1.1, width / layout.width, height / layout.height), 0.05)
    const tx = Math.max(20, (width - layout.width * scale) / 2)
    svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, 20).scale(scale))

    svg.append('defs').append('marker')
      .attr('id', 'arr-h')
      .attr('viewBox', '0 -4 8 8').attr('refX', 8).attr('refY', 0)
      .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', '#4b5563')

    const linkGenV = d3.linkVertical<{ source: { x: number; y: number }; target: { x: number; y: number } }, { x: number; y: number }>()
      .x(d => d.x).y(d => d.y)
    const linkGenH = d3.linkHorizontal<{ source: { x: number; y: number }; target: { x: number; y: number } }, { x: number; y: number }>()
      .x(d => d.x).y(d => d.y)

    function linePoints(line: LayoutLine): { source: { x: number; y: number }; target: { x: number; y: number } } | null {
      if (line.kind === 'private-l3') {
        const card = cardPos.get(qualify(line.samplerId, line.aId))
        const l3 = l3Pos.get(line.samplerId)
        if (!card || !l3) return null
        return { source: { x: card.x, y: card.y + CARD_H / 2 }, target: { x: l3.x, y: l3.y - L3_H / 2 } }
      }
      if (line.kind === 'l3-external') {
        const l3 = l3Pos.get(line.samplerId)
        const card = cardPos.get(qualify(line.samplerId, line.bId))
        if (!card || !l3) return null
        return { source: { x: l3.x, y: l3.y + L3_H / 2 }, target: { x: card.x, y: card.y - CARD_H / 2 } }
      }
      const a = cardPos.get(qualify(line.samplerId, line.aId))
      const b = cardPos.get(qualify(line.samplerId, line.bId))
      if (!a || !b) return null
      return { source: { x: a.x, y: a.y }, target: { x: b.x, y: b.y } }
    }

    const validLines = layout.lines
      .map(line => ({ line, pts: linePoints(line) }))
      .filter((d): d is { line: LayoutLine; pts: { source: { x: number; y: number }; target: { x: number; y: number } } } => !!d.pts)

    // ── Grouping boxes (subnets + external band) — drawn first, behind everything ──
    const boxGroup = g.append('g')
    boxGroup.selectAll('rect.subnet-box')
      .data(layout.subnetBoxes).join('rect')
      .attr('class', 'subnet-box')
      .attr('x', d => d.x).attr('y', d => d.y).attr('width', d => d.w).attr('height', d => d.h)
      .attr('rx', 10).attr('fill', 'none').attr('stroke', '#374151').attr('stroke-width', 1)
    boxGroup.selectAll('text.subnet-label')
      .data(layout.subnetBoxes).join('text')
      .attr('class', 'subnet-label')
      .attr('x', d => d.x + 12).attr('y', d => d.y + 18)
      .attr('font-size', '11px').attr('font-weight', '600').attr('fill', '#9ca3af')
      .text(d => d.label)
    boxGroup.selectAll('rect.ext-box')
      .data(layout.externalBoxes).join('rect')
      .attr('class', 'ext-box')
      .attr('x', d => d.x).attr('y', d => d.y).attr('width', d => d.w).attr('height', d => d.h)
      .attr('rx', 10).attr('fill', 'none').attr('stroke', '#374151').attr('stroke-width', 1)
    boxGroup.selectAll('text.ext-label')
      .data(layout.externalBoxes).join('text')
      .attr('class', 'ext-label')
      .attr('x', d => d.x + 12).attr('y', d => d.y + 18)
      .attr('font-size', '11px').attr('font-weight', '600').attr('fill', '#9ca3af')
      .text(d => d.label)

    g.append('g').selectAll('text.sampler-header')
      .data(layout.headers).join('text')
      .attr('class', 'sampler-header')
      .attr('x', d => d.x).attr('y', d => d.y)
      .attr('font-size', '12px').attr('font-weight', '700').attr('fill', '#e5e7eb')
      .text(d => d.text)

    // ── Links ─────────────────────────────────────────────────────────────────
    // private<->private links draw thin and dashed (they never cross the L3
    // boundary at all); private-l3/l3-external links carry real aggregated
    // weight and get an arrowhead showing the direction of the hierarchy.
    const linkSel = g.append('g').selectAll<SVGPathElement, typeof validLines[number]>('path')
      .data(validLines).join('path')
      .attr('fill', 'none')
      .attr('stroke', d => d.line.kind === 'private-private' ? '#6b7280' : '#4b5563')
      .attr('stroke-dasharray', d => d.line.kind === 'private-private' ? '4,3' : null)
      .attr('stroke-width', d => wScale(d.line.bytes))
      .attr('stroke-opacity', 0.65)
      .attr('marker-end', d => d.line.kind === 'private-private' ? null : 'url(#arr-h)')
      .attr('d', d => (d.line.kind === 'private-private' ? linkGenH(d.pts) : linkGenV(d.pts))!)

    // ── L3 nodes — generic by design: no IP, no stats, just what it is ─────────
    const l3Sel = g.append('g').selectAll<SVGGElement, typeof layout.l3Boxes[number]>('g')
      .data(layout.l3Boxes).join('g')
      .attr('transform', d => `translate(${d.x},${d.y})`)
      .attr('cursor', 'default')

    l3Sel.append('rect')
      .attr('x', -L3_W / 2).attr('y', -L3_H / 2).attr('width', L3_W).attr('height', L3_H)
      .attr('rx', 8).attr('ry', 8)
      .attr('fill', '#111827')
      .attr('stroke', '#6b7280').attr('stroke-width', 1.5).attr('stroke-dasharray', '4,2')

    l3Sel.append('text')
      .text('L3')
      .attr('text-anchor', 'middle').attr('y', -4)
      .attr('font-size', '13px').attr('font-weight', '700').attr('fill', '#d1d5db').attr('letter-spacing', '0.05em')

    l3Sel.append('text')
      .text('network boundary')
      .attr('text-anchor', 'middle').attr('y', 12)
      .attr('font-size', '8px').attr('fill', '#6b7280')

    // ── Device cards (private + external) ───────────────────────────────────────
    const TEXT_X = -CARD_W / 2 + 14

    const cardSel = g.append('g').selectAll<SVGGElement, typeof layout.cards[number]>('g')
      .data(layout.cards).join('g')
      .attr('transform', c => `translate(${c.x},${c.y})`)
      .attr('cursor', 'pointer')
      .on('click', (_, c) => navigate(`/explorer?src_ip=${encodeURIComponent(c.node.id)}&any_direction=true&window=${window_}`))

    cardSel.append('rect')
      .attr('class', 'card-border')
      .attr('x', -CARD_W / 2).attr('y', -CARD_H / 2)
      .attr('width', CARD_W).attr('height', CARD_H)
      .attr('rx', 8).attr('ry', 8)
      .attr('fill', '#1f2937')
      .attr('stroke', c => siteColor(c.node.site || 'unknown'))
      .attr('stroke-width', 1.25)

    cardSel.append('rect')
      .attr('x', -CARD_W / 2).attr('y', -CARD_H / 2)
      .attr('width', 4).attr('height', CARD_H)
      .attr('fill', c => siteColor(c.node.site || 'unknown'))

    cardSel.append('text')
      .text(c => truncateLabel(c.node.sampler_name || c.node.id, 21))
      .attr('x', TEXT_X).attr('y', -6)
      .attr('font-size', '11px').attr('font-weight', '600').attr('fill', '#f3f4f6')

    cardSel.append('text')
      .text(c => c.node.sampler_name ? c.node.id : (c.node.site || (c.kind === 'external' ? 'external' : '')))
      .attr('x', TEXT_X).attr('y', 8)
      .attr('font-size', '9px').attr('font-family', 'monospace').attr('fill', '#9ca3af')

    cardSel.append('text')
      .text(c => `${fmtBytes(c.node.bytes)} · ${c.node.flows.toLocaleString()} fl`)
      .attr('x', TEXT_X).attr('y', 20)
      .attr('font-size', '8.5px').attr('fill', '#6b7280')

    // ── Tooltip + hover highlight ────────────────────────────────────────────────
    // Always-on: hovering a device highlights its own line to L3 plus only the
    // specific peers it actually reaches on the other side of L3 (not every
    // device passing through that sampler); hovering L3 itself lights up
    // everything that sampler observed.
    const { tip, show: showTip, move: moveTip, hide: hideTip } = attachTooltip()

    function computeKeep(kind: 'private' | 'external' | 'l3', id: string, samplerId: string): Set<string> {
      const band = bandById.get(samplerId)
      const keep = new Set<string>()
      if (!band) return keep
      if (kind === 'private') {
        keep.add(qualify(samplerId, id)); keep.add(l3Key(samplerId))
        band.privateLine.get(id)?.peerIds.forEach(x => keep.add(qualify(samplerId, x)))
        band.privatePrivateEdges.forEach(e => {
          if (e.source === id) keep.add(qualify(samplerId, e.target))
          if (e.target === id) keep.add(qualify(samplerId, e.source))
        })
      } else if (kind === 'external') {
        keep.add(qualify(samplerId, id)); keep.add(l3Key(samplerId))
        band.externalLine.get(id)?.peerIds.forEach(x => keep.add(qualify(samplerId, x)))
      } else {
        keep.add(l3Key(samplerId))
        band.privateLine.forEach((_, pid) => keep.add(qualify(samplerId, pid)))
        band.externalLine.forEach((_, eid) => keep.add(qualify(samplerId, eid)))
        band.privatePrivateEdges.forEach(e => { keep.add(qualify(samplerId, e.source)); keep.add(qualify(samplerId, e.target)) })
      }
      return keep
    }

    const HIGHLIGHT_COLOR = '#60a5fa'
    const baseLinkColor = (d: typeof validLines[number]) => d.line.kind === 'private-private' ? '#6b7280' : '#4b5563'

    function isLineActive(d: typeof validLines[number], keep: Set<string>): boolean {
      const { line } = d
      if (line.kind === 'private-l3') return keep.has(qualify(line.samplerId, line.aId)) && keep.has(l3Key(line.samplerId))
      if (line.kind === 'l3-external') return keep.has(qualify(line.samplerId, line.bId)) && keep.has(l3Key(line.samplerId))
      return keep.has(qualify(line.samplerId, line.aId)) && keep.has(qualify(line.samplerId, line.bId))
    }

    function applyHighlight(keep: Set<string>) {
      cardSel.attr('opacity', c => keep.has(qualify(c.samplerId, c.node.id)) ? 1 : 0.25)
      cardSel.select<SVGRectElement>('rect.card-border')
        .attr('stroke', c => keep.has(qualify(c.samplerId, c.node.id)) ? HIGHLIGHT_COLOR : siteColor(c.node.site || 'unknown'))
        .attr('stroke-width', c => keep.has(qualify(c.samplerId, c.node.id)) ? 2.5 : 1.25)
      l3Sel.attr('opacity', d => keep.has(l3Key(d.sampler.id)) ? 1 : 0.25)
      linkSel
        .attr('opacity', d => isLineActive(d, keep) ? 1 : 0.12)
        .attr('stroke', d => isLineActive(d, keep) ? HIGHLIGHT_COLOR : baseLinkColor(d))
        .attr('stroke-width', d => isLineActive(d, keep) ? Math.max(2, wScale(d.line.bytes)) : wScale(d.line.bytes))
    }
    function clearHighlight() {
      cardSel.attr('opacity', 1)
      cardSel.select<SVGRectElement>('rect.card-border')
        .attr('stroke', c => siteColor(c.node.site || 'unknown'))
        .attr('stroke-width', 1.25)
      l3Sel.attr('opacity', 1)
      linkSel
        .attr('opacity', 1)
        .attr('stroke', d => baseLinkColor(d))
        .attr('stroke-width', d => wScale(d.line.bytes))
    }

    // The card itself already shows name/id/bytes/flows — repeating that in
    // the tooltip adds nothing, so the tooltip instead lists the actual
    // connections (peer IP, port, protocol) that aren't visible on the card.
    const MAX_TOOLTIP_ROWS = 10
    function connectionRows(deviceId: string, samplerId: string): string {
      const rows = data.edges
        .filter(e => e.sampler_ip === samplerId && (e.source === deviceId || e.target === deviceId))
        .sort((a, b) => b.bytes - a.bytes)
      if (!rows.length) return '<br><span style="color:#9ca3af">No recorded connections</span>'
      const shown = rows.slice(0, MAX_TOOLTIP_ROWS).map(e => {
        const peer = e.source === deviceId ? e.target : e.source
        const port = e.dst_port ? `:${e.dst_port}` : ''
        return `<br>${peer}${port} <span style="color:#6b7280">${protoShort(e.protocol)} · ${fmtBytes(e.bytes)}</span>`
      }).join('')
      const more = rows.length > MAX_TOOLTIP_ROWS ? `<br><span style="color:#6b7280">+${rows.length - MAX_TOOLTIP_ROWS} more</span>` : ''
      return shown + more
    }

    cardSel
      .on('mouseenter', (ev, c) => {
        applyHighlight(computeKeep(c.kind, c.node.id, c.samplerId))
        showTip(ev, `
          <b>${c.node.sampler_name || c.node.id}</b>
          ${connectionRows(c.node.id, c.samplerId)}
        `)
      })
      .on('mousemove', moveTip)
      .on('mouseleave', () => { clearHighlight(); hideTip() })

    l3Sel
      .on('mouseenter', (ev, d) => {
        applyHighlight(computeKeep('l3', '', d.sampler.id))
        showTip(ev, `
          <b>L3 — network boundary</b>
          <br><span style="color:#9ca3af">Every private↔external conversation ${d.sampler.sampler_name || d.sampler.id} observed passes through here. Generic by design — this represents the boundary itself, not a specific guessed router.</span>
        `)
      })
      .on('mousemove', moveTip)
      .on('mouseleave', () => { clearHighlight(); hideTip() })

    linkSel
      .attr('cursor', d => d.line.kind === 'private-private' ? 'pointer' : 'default')
      .on('click', (_, d) => {
        if (d.line.kind !== 'private-private') return
        navigate(`/explorer?src_ip=${encodeURIComponent(d.line.aId)}&dst_ip=${encodeURIComponent(d.line.bId)}&any_direction=true&window=${window_}`)
      })
      .on('mouseenter', (ev, d) => {
        const { line } = d
        if (line.kind === 'private-l3') applyHighlight(computeKeep('private', line.aId, line.samplerId))
        else if (line.kind === 'l3-external') applyHighlight(computeKeep('external', line.bId, line.samplerId))
        else applyHighlight(new Set([qualify(line.samplerId, line.aId), qualify(line.samplerId, line.bId)]))

        if (line.kind === 'private-private') {
          const e = line.edge!
          const asymFlag = e.is_asymmetric
            ? `<br><span style="color:#f59e0b">⚠ Asymmetric — one side sent ≥10× the other</span>`
            : ''
          showTip(ev, `
            <b>${e.source} ↔ ${e.target}</b>
            <br>Total: ${fmtBytes(e.bytes)} · ${e.flows.toLocaleString()} flows
            <br>→ ${fmtBytes(e.bytes_fwd)} &nbsp; ← ${fmtBytes(e.bytes_rev)}
            <br><span style="color:#9ca3af">${protoShort(e.protocol)}${e.dst_port ? `:${e.dst_port}` : ''}</span>
            ${asymFlag}
            <br><span style="color:#9ca3af">Click to view these flows in Explorer</span>
          `)
        } else {
          const label = line.kind === 'private-l3' ? line.aId : line.bId
          showTip(ev, `
            <b>${label} ↔ L3</b>
            <br>Total: ${fmtBytes(line.bytes)} · ${line.flows.toLocaleString()} flows
            <br><span style="color:#9ca3af">Click ${label} directly to view its flows in Explorer</span>
          `)
        }
      })
      .on('mousemove', moveTip)
      .on('mouseleave', () => { clearHighlight(); hideTip() })

    // Legend
    renderSiteLegend(svg, sites, siteColor)

    return () => { tip.remove() }
  }, [data, width, height, svgRef, window_, navigate])

  return <svg ref={svgRef} width={width} height={height} />
}

// ── Export helpers ────────────────────────────────────────────────────────────

function dlBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ── Main page ─────────────────────────────────────────────────────────────────

const WINDOWS = ['15m', '1h', '6h', '24h', '7d']

export default function Topology() {
  const navigate       = useNavigate()
  const containerRef   = useRef<HTMLDivElement>(null)
  const svgRef         = useRef<SVGSVGElement>(null)
  const exportMenuRef  = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 900, h: 600 })

  const [layout, setLayout]      = useState<'hierarchical' | 'force'>('hierarchical')
  const [window_, setWindow]     = useState('1h')
  const [sampler, setSampler]    = useState('')
  const [minBytes, setMinBytes]  = useState('')
  const [devices, setDevices]    = useState<DeviceSummary[]>([])
  const [deviceNames, setDeviceNames] = useState<Map<string, string>>(new Map())
  const [data, setData]          = useState<{ nodes: TopologyNode[]; edges: TopologyEdge[] } | null>(null)
  const [loading, setLoading]    = useState(false)
  const [selected, setSelected]  = useState<TopologyNode | null>(null)
  const [error, setError]        = useState('')
  const [showExport, setShowExport] = useState(false)
  const [exportMsg, setExportMsg]   = useState('')

  // Responsive sizing
  useEffect(() => {
    const measure = () => {
      if (containerRef.current) {
        setDims({ w: containerRef.current.clientWidth, h: Math.max(480, containerRef.current.clientHeight) })
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (containerRef.current) ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // Close export dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExport(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  useEffect(() => {
    api.getDeviceSummaries().then(setDevices)
    api.getDevices().then(ds => {
      setDeviceNames(new Map(ds.map(d => [d.ip, d.name])))
    })
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params: Record<string, string> = { window: window_ }
      if (sampler)  params.sampler_ip = sampler
      if (minBytes) params.min_bytes  = minBytes
      setData(await api.getTopology(params))
    } catch (e: any) {
      setError(e.message || 'Failed to load topology')
    } finally {
      setLoading(false)
    }
  }, [window_, sampler, minBytes])

  useEffect(() => { load() }, [])

  // ── Export functions ────────────────────────────────────────────────────────

  /** Clone the SVG with zoom transform removed and viewBox fitted to all content. */
  function buildFullSVGClone(): { clone: SVGSVGElement; w: number; h: number } | null {
    if (!svgRef.current) return null
    const svgEl = svgRef.current
    // The zoom group is the first <g> child of the SVG
    const zoomG = svgEl.querySelector(':scope > g') as SVGGElement | null
    if (!zoomG) return null

    // getBBox() returns the bounding box of all content in g's LOCAL coordinate
    // space (before the zoom/pan transform is applied) — exactly what we want.
    const bbox = zoomG.getBBox()
    const pad = 48
    const vx = bbox.x - pad
    const vy = bbox.y - pad
    const vw = bbox.width  + pad * 2
    const vh = bbox.height + pad * 2

    const clone = svgEl.cloneNode(true) as SVGSVGElement
    // Strip the zoom transform so all nodes render in their simulation positions
    const cloneZoomG = clone.querySelector(':scope > g') as SVGGElement | null
    if (cloneZoomG) cloneZoomG.removeAttribute('transform')

    // Add a dark background so PNG doesn't render on transparent
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    bg.setAttribute('x', String(vx)); bg.setAttribute('y', String(vy))
    bg.setAttribute('width', String(vw)); bg.setAttribute('height', String(vh))
    bg.setAttribute('fill', '#111827')
    cloneZoomG?.insertBefore(bg, cloneZoomG.firstChild)

    clone.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`)
    clone.setAttribute('width',  String(vw))
    clone.setAttribute('height', String(vh))

    return { clone, w: vw, h: vh }
  }

  function doExportSVG() {
    const result = buildFullSVGClone()
    if (!result) return
    const s = new XMLSerializer().serializeToString(result.clone)
    dlBlob(new Blob([s], { type: 'image/svg+xml' }), 'pktflow-topology.svg')
    setShowExport(false)
  }

  function doExportPNG() {
    setShowExport(false)
    const result = buildFullSVGClone()
    if (!result) return
    const { clone, w, h } = result
    const s = new XMLSerializer().serializeToString(clone)
    const blob = new Blob([s], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      const ctx = c.getContext('2d')!
      ctx.fillStyle = '#111827'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0)
      c.toBlob(b => { if (b) dlBlob(b, 'pktflow-topology.png') }, 'image/png')
      URL.revokeObjectURL(url)
    }
    img.src = url
  }

  function doExportJSON() {
    if (!data) return
    dlBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'pktflow-topology.json')
    setShowExport(false)
  }

  function doExportDOT() {
    if (!data) return
    let dot = 'digraph pktflow_topology {\n'
    dot += '  graph [bgcolor="#111827" fontcolor="#d1d5db"];\n'
    dot += '  node [shape=circle fontcolor="#d1d5db" style=filled fontsize=10];\n'
    dot += '  edge [color="#4b5563" fontsize=9 fontcolor="#9ca3af"];\n\n'
    data.nodes.forEach(n => {
      const label = (n.sampler_name || n.id).replace(/"/g, '\\"')
      const tooltip = `${fmtBytes(n.bytes)}, ${n.flows} flows`.replace(/"/g, '\\"')
      dot += `  "${n.id}" [label="${label}" tooltip="${tooltip}"];\n`
    })
    dot += '\n'
    data.edges.forEach(e => {
      const src = typeof e.source === 'string' ? e.source : (e.source as any).id
      const dst = typeof e.target === 'string' ? e.target : (e.target as any).id
      dot += `  "${src}" -> "${dst}" [label="${fmtBytes(e.bytes)}"];\n`
    })
    dot += '}'
    dlBlob(new Blob([dot], { type: 'text/plain' }), 'pktflow-topology.dot')
    setShowExport(false)
  }

  function doExportDrawio() {
    if (!data) return
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    xml += '<mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1654" pageHeight="1169" math="0" shadow="0">\n'
    xml += '  <root>\n    <mxCell id="0"/>\n    <mxCell id="1" parent="0"/>\n'

    const cols = Math.ceil(Math.sqrt(data.nodes.length)) || 1
    data.nodes.forEach((n, i) => {
      const label = esc(n.sampler_name || n.id)
      const x = 60 + (i % cols) * 160
      const y = 60 + Math.floor(i / cols) * 160
      const color = SITE_COLORS[0]
      xml += `    <mxCell id="n_${i}" value="${label}" style="ellipse;fillColor=${color};strokeColor=#1d4ed8;fontColor=#ffffff;fontSize=10;fontStyle=1;" vertex="1" parent="1">`
      xml += `<mxGeometry x="${x}" y="${y}" width="80" height="80" as="geometry"/></mxCell>\n`
    })

    const nodeIndex = new Map(data.nodes.map((n, i) => [n.id, i]))
    data.edges.forEach((e, i) => {
      const src = typeof e.source === 'string' ? e.source : (e.source as any).id
      const dst = typeof e.target === 'string' ? e.target : (e.target as any).id
      const si = nodeIndex.get(src)
      const ti = nodeIndex.get(dst)
      if (si === undefined || ti === undefined) return
      const lbl = esc(fmtBytes(e.bytes))
      xml += `    <mxCell id="e_${i}" value="${lbl}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;exitX=0.5;exitY=0;entryX=0.5;entryY=1;fontSize=9;fontColor=#9ca3af;" edge="1" source="n_${si}" target="n_${ti}" parent="1">`
      xml += `<mxGeometry relative="1" as="geometry"/></mxCell>\n`
    })

    xml += '  </root>\n</mxGraphModel>'
    dlBlob(new Blob([xml], { type: 'application/xml' }), 'pktflow-topology.drawio')
    setShowExport(false)
  }

  async function doExportLucidchart() {
    setShowExport(false)
    setExportMsg('Sending to Lucidchart…')
    try {
      const token = localStorage.getItem('token')
      const params = new URLSearchParams({ window: window_ })
      if (sampler)  params.set('sampler_ip', sampler)
      if (minBytes) params.set('min_bytes', minBytes)
      const res = await fetch(`/api/flows/topology/lucidchart?${params.toString()}`, {
        method: 'POST',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
      if (res.ok) {
        const { edit_url } = await res.json()
        window.open(edit_url, '_blank', 'noopener')
        setExportMsg('')
      } else {
        const body = await res.json().catch(() => null)
        setExportMsg(body?.detail || 'Lucidchart export requires an API token in Settings → Integrations.')
        setTimeout(() => setExportMsg(''), 4000)
      }
    } catch {
      setExportMsg('Lucidchart export failed — check your connection and try again.')
      setTimeout(() => setExportMsg(''), 4000)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-3" style={{ height: 'calc(100vh - 7rem)' }}>

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap shrink-0">
        <h1 className="text-xl font-bold text-white mr-1">Topology</h1>
        <HelpButton title="Topology — How It Works">
          <p><span className="text-gray-300 font-medium">Hierarchical</span> (default) is a fixed 3-band diagram per NetFlow sampler: private devices at top (grouped into their own labeled subnet boxes), a single generic <span className="text-gray-300 font-medium">L3</span> node in the middle, external destinations at bottom. L3 is deliberately generic — no IP, no stats — it represents the network boundary itself, not a specific guessed router. A destination reached by five different internal hosts still renders once, with five lines converging on it — never duplicated, never chained through unrelated conversations. Private↔private traffic (which never crosses the L3 boundary) draws as a direct dashed line instead. <span className="text-gray-300 font-medium">Force</span> keeps the original free-floating graph, grouped into site clusters.</p>
          <p>Cards are IP addresses, sized/labeled by total bytes and flows, colored by site. Link width is proportional to bytes; amber flags an asymmetric private↔private conversation (one side sent ≥10× the other).</p>
          <p><span className="text-gray-300 font-medium">Hover</span> a device to highlight its own line to L3 plus only the specific peers it actually reaches on the far side — not every device passing through that sampler. Hover the L3 node itself to light up everything that sampler observed. <span className="text-gray-300 font-medium">Click</span> a device (or a private↔private link) to jump into Flow Explorer, filtered to that traffic in either direction for the current window — the L3 node itself isn't clickable, since it's not a real flow endpoint.</p>
          <p><span className="text-gray-300 font-medium">Export</span> covers PNG/SVG/JSON/DOT/Draw.io of the current layout, plus a direct push to Lucidchart if an API token is set (Settings → Integrations) — useful for handing the current graph to something outside pktFlow.</p>
        </HelpButton>

        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
          {(['hierarchical', 'force'] as const).map(l => (
            <button key={l} onClick={() => setLayout(l)}
              className={`text-xs px-3 py-1.5 rounded-lg transition-colors capitalize ${layout === l ? 'bg-gray-700 text-white' : 'text-white hover:text-white'}`}>
              {l}
            </button>
          ))}
        </div>

        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
          {WINDOWS.map(w => (
            <button key={w} onClick={() => setWindow(w)}
              className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${window_ === w ? 'bg-gray-700 text-white' : 'text-white hover:text-white'}`}>
              {w}
            </button>
          ))}
        </div>

        <select value={sampler} onChange={e => setSampler(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">All samplers</option>
          {devices.map(d => (
            <option key={d.sampler_ip} value={d.sampler_ip}>{(() => { const n = deviceNames.get(d.sampler_ip) || d.sampler_name; return n ? `${n} (${d.sampler_ip})` : d.sampler_ip; })()}</option>
          ))}
        </select>

        <input value={minBytes} onChange={e => setMinBytes(e.target.value)}
          placeholder="Min bytes (noise filter)"
          className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 w-44 focus:outline-none focus:ring-2 focus:ring-blue-500" />

        <button onClick={load} disabled={loading}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-1.5 transition-colors">
          {loading ? 'Loading…' : 'Refresh'}
        </button>

        {/* Export dropdown */}
        <div className="relative" ref={exportMenuRef}>
          <button
            onClick={() => setShowExport(v => !v)}
            disabled={!data || data.nodes.length === 0}
            className="flex items-center gap-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 border border-gray-700 text-white text-sm font-medium rounded-lg px-3 py-1.5 transition-colors"
            title="Export topology">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Export
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>

          {showExport && (
            <div className="absolute right-0 top-full mt-1.5 z-50 bg-gray-900 border border-gray-700 rounded-xl shadow-xl overflow-hidden min-w-[160px]">
              {[
                { label: 'SVG image',      sub: '.svg',     fn: doExportSVG     },
                { label: 'PNG image',      sub: '.png',     fn: doExportPNG     },
                { label: 'JSON data',      sub: '.json',    fn: doExportJSON    },
                { label: 'Graphviz DOT',   sub: '.dot',     fn: doExportDOT     },
                { label: 'Draw.io',        sub: '.drawio',  fn: doExportDrawio  },
                { label: 'Lucidchart',     sub: 'API token required', fn: doExportLucidchart },
              ].map(({ label, sub, fn }) => (
                <button key={label} onClick={fn}
                  className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-sm text-white hover:bg-gray-800 transition-colors text-left">
                  <span>{label}</span>
                  <span className="text-xs text-gray-500 shrink-0">{sub}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {data && (
          <span className="text-xs text-white ml-auto">
            {data.nodes.length} nodes · {data.edges.length} edges
          </span>
        )}
      </div>

      {error    && <p className="text-sm text-red-400 shrink-0">{error}</p>}
      {exportMsg && <p className="text-sm text-yellow-400 shrink-0">{exportMsg}</p>}

      {/* Node detail panel */}
      {selected && (
        <div className="shrink-0 bg-gray-900 border border-gray-700 rounded-xl p-4 flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-white font-semibold">{selected.sampler_name || selected.id}</span>
              {selected.is_sampler && (
                <span className="text-xs bg-blue-600/20 text-blue-400 border border-blue-500/30 rounded px-2 py-0.5">
                  NetFlow sampler
                </span>
              )}
              {selected.site && <span className="text-xs text-white">{selected.site}</span>}
            </div>
            <IpLink ip={selected.id} className="text-sm font-mono text-white" />
            <div className="flex gap-6 mt-2 text-sm">
              <div>
                <p className="text-xs text-white">Total bytes</p>
                <p className="text-white font-medium">{fmtBytes(selected.bytes)}</p>
              </div>
              <div>
                <p className="text-xs text-white">Flow count</p>
                <p className="text-white font-medium">{selected.flows.toLocaleString()}</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => navigate(`/explorer?src_ip=${selected.id}&window=${window_}`)}
              className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white hover:text-white rounded-lg px-3 py-2 transition-colors whitespace-nowrap">
              Flows from →
            </button>
            <button
              onClick={() => navigate(`/explorer?dst_ip=${selected.id}&window=${window_}`)}
              className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white hover:text-white rounded-lg px-3 py-2 transition-colors whitespace-nowrap">
              Flows to →
            </button>
            <button onClick={() => setSelected(null)}
              className="text-white hover:text-white text-sm ml-1">✕</button>
          </div>
        </div>
      )}

      {/* Graph canvas */}
      <div ref={containerRef}
        className="flex-1 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden relative">

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80 z-10">
            <p className="text-sm text-white">Building topology…</p>
          </div>
        )}

        {!loading && data && data.nodes.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
            <p className="text-sm">No flow data in this window.</p>
            <p className="text-xs mt-1">Try a longer window or lower the min-bytes filter.</p>
          </div>
        )}

        {data && data.nodes.length > 0 && (
          layout === 'hierarchical' ? (
            <HierarchicalGraph
              svgRef={svgRef}
              data={data}
              width={dims.w}
              height={dims.h}
              window_={window_}
            />
          ) : (
            <ForceGraph
              svgRef={svgRef}
              data={data}
              onNodeClick={setSelected}
              width={dims.w}
              height={dims.h}
            />
          )
        )}

        <p className="absolute bottom-3 left-3 text-xs text-white pointer-events-none select-none">
          {layout === 'hierarchical'
            ? 'Scroll to zoom · Drag to pan · Hover to trace · Click to view flows'
            : 'Scroll to zoom · Drag nodes · Click to inspect'}
        </p>
      </div>
    </div>
  )
}
