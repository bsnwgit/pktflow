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

// ── D3 Graph ──────────────────────────────────────────────────────────────────

interface D3Node extends TopologyNode {
  x?: number; y?: number; fx?: number | null; fy?: number | null
  _id: string
}

interface D3Link extends d3.SimulationLinkDatum<D3Node> {
  bytes: number; flows: number; protocol: number; dst_port: number
}

function TopologyGraph({
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
    const siteColor = (s: string) => SITE_COLORS[sites.indexOf(s) % SITE_COLORS.length]

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
    const tip = d3.select('body').append('div')
      .style('position', 'fixed').style('background', '#111827')
      .style('border', '1px solid #374151').style('border-radius', '8px')
      .style('padding', '8px 12px').style('font-size', '12px')
      .style('color', '#f3f4f6').style('pointer-events', 'none')
      .style('opacity', '0').style('z-index', '9999')
      .style('max-width', '220px').style('line-height', '1.6')

    const showTip = (ev: MouseEvent, html: string) => {
      tip.style('opacity', '1').html(html)
    }
    const moveTip = (ev: MouseEvent) => {
      tip.style('left', ev.clientX + 14 + 'px').style('top', ev.clientY - 10 + 'px')
    }
    const hideTip = () => tip.style('opacity', '0')

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
    const legend = svg.append('g').attr('transform', 'translate(12,12)')
    sites.slice(0, 8).forEach((site, i) => {
      const row = legend.append('g').attr('transform', `translate(0,${i * 18})`)
      row.append('circle').attr('r', 5).attr('cx', 5).attr('cy', 5).attr('fill', siteColor(site))
      row.append('text').text(site).attr('x', 14).attr('y', 9)
        .attr('fill', '#9ca3af').attr('font-size', '10px')
    })

    return () => { sim.stop(); tip.remove() }
  }, [data, width, height, onNodeClick, svgRef])

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
    if (!svgRef.current) return
    setShowExport(false)
    setExportMsg('Sending to Lucidchart…')
    const svgStr = new XMLSerializer().serializeToString(svgRef.current)
    try {
      const token = localStorage.getItem('token')
      const res = await fetch('/api/topology/export/lucidchart', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ svg: svgStr }),
      })
      if (res.ok) {
        const { url } = await res.json()
        window.open(url, '_blank')
        setExportMsg('')
      } else {
        setExportMsg('Lucidchart export requires an API token in Settings → Integrations.')
        setTimeout(() => setExportMsg(''), 4000)
      }
    } catch {
      setExportMsg('Lucidchart export requires an API token in Settings → Integrations.')
      setTimeout(() => setExportMsg(''), 4000)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-3" style={{ height: 'calc(100vh - 7rem)' }}>

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap shrink-0">
        <h1 className="text-xl font-bold text-white mr-1">Topology</h1>

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
            <p className="text-sm font-mono text-white">{selected.id}</p>
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
          <TopologyGraph
            svgRef={svgRef}
            data={data}
            onNodeClick={setSelected}
            width={dims.w}
            height={dims.h}
          />
        )}

        <p className="absolute bottom-3 left-3 text-xs text-white pointer-events-none select-none">
          Scroll to zoom · Drag nodes · Click to inspect
        </p>
      </div>
    </div>
  )
}
