/**
 * Network Topology page — D3 force-directed graph of IP communication pairs.
 * Nodes = IP addresses; edges = aggregated flows between them.
 * Node size  ∝ total bytes.  Edge width ∝ bytes.  Color = site.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import * as d3 from 'd3'
import { useNavigate } from 'react-router-dom'
import { api, TopologyNode, TopologyEdge, DeviceSummary } from '../api/client'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB'
  if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB'
  if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB'
  return b + ' B'
}

const PROTO_NAMES: Record<number, string> = {
  1: 'ICMP', 6: 'TCP', 17: 'UDP', 47: 'GRE', 50: 'ESP',
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
  data,
  onNodeClick,
  width,
  height,
}: {
  data: { nodes: TopologyNode[]; edges: TopologyEdge[] }
  onNodeClick: (node: TopologyNode) => void
  width: number
  height: number
}) {
  const svgRef = useRef<SVGSVGElement>(null)

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

    const link = g.append('g').selectAll<SVGLineElement, D3Link>('line')
      .data(links).join('line')
      .attr('stroke', '#374151')
      .attr('stroke-width', d => wScale(d.bytes))
      .attr('stroke-opacity', 0.7)
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

    // Tooltip (attached to document body to escape SVG stacking)
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
        showTip(ev, `
          <b>${src} → ${dst}</b>
          <br>${fmtBytes(d.bytes)} · ${d.flows.toLocaleString()} flows
          <br><span style="color:#9ca3af">${PROTO_NAMES[d.protocol] || `Proto ${d.protocol}`}${d.dst_port ? `:${d.dst_port}` : ''}</span>
        `)
      })
      .on('mousemove', moveTip).on('mouseleave', hideTip)

    const sim = d3.forceSimulation<D3Node>(nodes)
      .force('link', d3.forceLink<D3Node, D3Link>(links)
        .id(d => d._id)
        .distance(d => 60 + Math.sqrt(d.bytes / maxEdgeBytes) * 100)
        .strength(0.4))
      .force('charge', d3.forceManyBody<D3Node>().strength(d => -120 - rScale(d.bytes) * 5))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide<D3Node>().radius(d => rScale(d.bytes) + 8))

    sim.on('tick', () => {
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
  }, [data, width, height, onNodeClick])

  return <svg ref={svgRef} width={width} height={height} />
}

// ── Main page ─────────────────────────────────────────────────────────────────

const WINDOWS = ['15m', '1h', '6h', '24h', '7d']

export default function Topology() {
  const navigate       = useNavigate()
  const containerRef   = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 900, h: 600 })

  const [window_, setWindow]   = useState('1h')
  const [sampler, setSampler]  = useState('')
  const [minBytes, setMinBytes] = useState('')
  const [devices, setDevices]  = useState<DeviceSummary[]>([])
  const [data, setData]        = useState<{ nodes: TopologyNode[]; edges: TopologyEdge[] } | null>(null)
  const [loading, setLoading]  = useState(false)
  const [selected, setSelected] = useState<TopologyNode | null>(null)
  const [error, setError]      = useState('')

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

  useEffect(() => { api.getDeviceSummaries().then(setDevices) }, [])

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

  return (
    <div className="flex flex-col gap-3" style={{ height: 'calc(100vh - 7rem)' }}>

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap shrink-0">
        <h1 className="text-xl font-bold text-white mr-1">Topology</h1>

        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1">
          {WINDOWS.map(w => (
            <button key={w} onClick={() => setWindow(w)}
              className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${window_ === w ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
              {w}
            </button>
          ))}
        </div>

        <select value={sampler} onChange={e => setSampler(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
          <option value="">All samplers</option>
          {devices.map(d => (
            <option key={d.sampler_ip} value={d.sampler_ip}>{d.sampler_name || d.sampler_ip}</option>
          ))}
        </select>

        <input value={minBytes} onChange={e => setMinBytes(e.target.value)}
          placeholder="Min bytes (noise filter)"
          className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 w-44 focus:outline-none focus:ring-2 focus:ring-blue-500" />

        <button onClick={load} disabled={loading}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-1.5 transition-colors">
          {loading ? 'Loading…' : 'Refresh'}
        </button>

        {data && (
          <span className="text-xs text-gray-500 ml-auto">
            {data.nodes.length} nodes · {data.edges.length} edges
          </span>
        )}
      </div>

      {error && <p className="text-sm text-red-400 shrink-0">{error}</p>}

      {/* Graph canvas */}
      <div ref={containerRef}
        className="flex-1 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden relative">

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80 z-10">
            <p className="text-sm text-gray-400">Building topology…</p>
          </div>
        )}

        {!loading && data && data.nodes.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-500">
            <p className="text-sm">No flow data in this window.</p>
            <p className="text-xs mt-1">Try a longer window or lower the min-bytes filter.</p>
          </div>
        )}

        {data && data.nodes.length > 0 && (
          <TopologyGraph
            data={data}
            onNodeClick={setSelected}
            width={dims.w}
            height={dims.h}
          />
        )}

        <p className="absolute bottom-3 left-3 text-xs text-gray-700 pointer-events-none select-none">
          Scroll to zoom · Drag nodes · Click to inspect
        </p>
      </div>

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
              {selected.site && <span className="text-xs text-gray-500">{selected.site}</span>}
            </div>
            <p className="text-sm font-mono text-gray-400">{selected.id}</p>
            <div className="flex gap-6 mt-2 text-sm">
              <div>
                <p className="text-xs text-gray-500">Total bytes</p>
                <p className="text-white font-medium">{fmtBytes(selected.bytes)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Flow count</p>
                <p className="text-white font-medium">{selected.flows.toLocaleString()}</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => navigate(`/explorer?src_ip=${selected.id}&window=${window_}`)}
              className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white rounded-lg px-3 py-2 transition-colors whitespace-nowrap">
              Flows from →
            </button>
            <button
              onClick={() => navigate(`/explorer?dst_ip=${selected.id}&window=${window_}`)}
              className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white rounded-lg px-3 py-2 transition-colors whitespace-nowrap">
              Flows to →
            </button>
            <button onClick={() => setSelected(null)}
              className="text-gray-500 hover:text-white text-sm ml-1">✕</button>
          </div>
        </div>
      )}
    </div>
  )
}
