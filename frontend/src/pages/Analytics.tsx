/**
 * Analytics — visual data exploration
 * Four chart types: area, pie, Sankey, node-link network map
 */
import { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend, ResponsiveContainer,
} from 'recharts'
import * as d3 from 'd3'
import { api, ProtocolStat, TimeSeriesPoint, TopologyResponse } from '../api/client'

// ── Colour palette ─────────────────────────────────────────────────────────────
const COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#84cc16','#ec4899','#a78bfa']

const WINDOWS = ['1h','6h','24h','7d','30d']

function fmt(n: number, unit: 'bytes' | 'flows' = 'bytes') {
  if (unit === 'flows') return n >= 1e6 ? `${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `${(n/1e3).toFixed(1)}K` : String(n)
  if (n >= 1e9) return `${(n/1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n/1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n/1e3).toFixed(1)} KB`
  return `${n} B`
}

function fmtTime(iso: string, window: string) {
  const d = new Date(iso)
  if (window === '7d' || window === '30d') return d.toLocaleDateString([], { month:'short', day:'numeric' })
  return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
}

// ── Sankey (pure SVG) ──────────────────────────────────────────────────────────
interface SankeyLink { source: number; target: number; value: number }
interface SankeyNode { name: string; x?: number; y?: number; h?: number; value?: number }

function buildSankeyLayout(
  nodes: SankeyNode[],
  links: SankeyLink[],
  width: number,
  height: number,
  padding = 8,
) {
  // Separate source-only and target-only buckets for left/right columns
  const srcIdx = new Set(links.map(l => l.source))
  const dstIdx = new Set(links.map(l => l.target))
  const srcNodes = nodes.filter((_, i) => srcIdx.has(i))
  const dstNodes = nodes.filter((_, i) => dstIdx.has(i))

  const nodeW = 14
  const colX = { src: 20, dst: width - 20 - nodeW }

  // Compute node totals
  const srcTotals = new Map<number, number>()
  const dstTotals = new Map<number, number>()
  links.forEach(l => {
    srcTotals.set(l.source, (srcTotals.get(l.source) ?? 0) + l.value)
    dstTotals.set(l.target, (dstTotals.get(l.target) ?? 0) + l.value)
  })

  const totalVal = links.reduce((s, l) => s + l.value, 0) || 1
  const usableH = height - padding * 2

  // Layout left column
  let y = padding
  const positioned: (SankeyNode & { x: number; y: number; h: number; value: number })[] = new Array(nodes.length)
  const srcList = [...srcIdx].sort((a, b) => (srcTotals.get(b) ?? 0) - (srcTotals.get(a) ?? 0))
  const srcH = (usableH - padding * (srcList.length - 1)) / srcList.length
  srcList.forEach(i => {
    positioned[i] = { ...nodes[i], x: colX.src, y, h: Math.max(srcH, 4), value: srcTotals.get(i) ?? 0 }
    y += srcH + padding
  })

  // Layout right column
  y = padding
  const dstList = [...dstIdx].sort((a, b) => (dstTotals.get(b) ?? 0) - (dstTotals.get(a) ?? 0))
  const dstH = (usableH - padding * (dstList.length - 1)) / dstList.length
  dstList.forEach(i => {
    positioned[i] = { ...nodes[i], x: colX.dst, y, h: Math.max(dstH, 4), value: dstTotals.get(i) ?? 0 }
    y += dstH + padding
  })

  // Build path data for each link
  const srcOffsets = new Map<number, number>()
  const dstOffsets = new Map<number, number>()
  const paths = links.map(l => {
    const sn = positioned[l.source], dn = positioned[l.target]
    if (!sn || !dn) return null
    const linkH = Math.max((l.value / totalVal) * usableH, 1)
    const sOff = srcOffsets.get(l.source) ?? 0
    const dOff = dstOffsets.get(l.target) ?? 0
    srcOffsets.set(l.source, sOff + linkH)
    dstOffsets.set(l.target, dOff + linkH)
    const x0 = sn.x + nodeW, y0 = sn.y + sOff
    const x1 = dn.x, y1 = dn.y + dOff
    const mx = (x0 + x1) / 2
    return { d: `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1} L${x1},${y1+linkH} C${mx},${y1+linkH} ${mx},${y0+linkH} ${x0},${y0+linkH} Z`, value: l.value }
  })

  return { positioned, paths }
}

function SankeyChart({ topology }: { topology: TopologyResponse }) {
  const W = 760, H = 340

  const { nodes, links } = useMemo(() => {
    const top = topology.edges.slice(0, 20)
    // Create separate src/dst namespace so IPs don't collide as same node
    const srcIPs = [...new Set(top.map(e => e.source))].slice(0, 10)
    const dstIPs = [...new Set(top.map(e => e.target))].slice(0, 10)
    const srcNodes: SankeyNode[] = srcIPs.map(ip => ({ name: ip }))
    const dstNodes: SankeyNode[] = dstIPs.map(ip => ({ name: ip }))
    const allNodes = [...srcNodes, ...dstNodes]
    const srcIdx = new Map(srcIPs.map((ip, i) => [ip, i]))
    const dstIdx = new Map(dstIPs.map((ip, i) => [ip, srcIPs.length + i]))
    const links: SankeyLink[] = []
    const seen = new Set<string>()
    for (const e of top) {
      const si = srcIdx.get(e.source), di = dstIdx.get(e.target)
      if (si === undefined || di === undefined) continue
      const key = `${si}-${di}`
      if (seen.has(key)) continue
      seen.add(key)
      links.push({ source: si, target: di, value: e.bytes })
    }
    return { nodes: allNodes, links }
  }, [topology])

  if (!links.length) return <Empty msg="No flow data for Sankey" />

  const { positioned, paths } = buildSankeyLayout(nodes, links, W, H)

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
      {paths.map((p, i) => p && (
        <path key={i} d={p.d} fill={COLORS[i % COLORS.length]} opacity={0.55}>
          <title>{fmt(p.value)}</title>
        </path>
      ))}
      {positioned.filter(Boolean).map((n, i) => (
        <g key={i}>
          <rect x={n.x} y={n.y} width={14} height={Math.max(n.h, 4)} fill={COLORS[i % COLORS.length]} rx={2} />
          <text
            x={n.x < W/2 ? n.x + 18 : n.x - 4}
            y={n.y + n.h / 2}
            textAnchor={n.x < W/2 ? 'start' : 'end'}
            dominantBaseline="middle"
            fontSize={10}
            fill="#9ca3af"
          >{n.name}</text>
        </g>
      ))}
    </svg>
  )
}

// ── Node-link network map (D3) ─────────────────────────────────────────────────
function NetworkMap({ topology }: { topology: TopologyResponse }) {
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!svgRef.current || !topology.nodes.length) return
    const W = svgRef.current.clientWidth || 760, H = 380

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const defs = svg.append('defs')
    defs.append('marker').attr('id','arrow').attr('viewBox','0 -4 8 8')
      .attr('refX',16).attr('refY',0).attr('markerWidth',6).attr('markerHeight',6)
      .attr('orient','auto')
      .append('path').attr('d','M0,-4L8,0L0,4').attr('fill','#4b5563')

    const maxBytes = d3.max(topology.nodes, n => n.bytes) || 1
    const rScale = d3.scaleSqrt().domain([0, maxBytes]).range([4, 22])
    const edgeScale = d3.scaleLinear()
      .domain([0, d3.max(topology.edges, e => e.bytes) || 1]).range([0.5, 5])

    const nodes = topology.nodes.map(n => ({ ...n })) as any[]
    const edges = topology.edges.slice(0, 80).map(e => ({
      source: nodes.find(n => n.id === e.source),
      target: nodes.find(n => n.id === e.target),
      bytes: e.bytes,
    })).filter(e => e.source && e.target) as any[]

    const sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(edges).id((d: any) => d.id).distance(90).strength(0.3))
      .force('charge', d3.forceManyBody().strength(-120))
      .force('center', d3.forceCenter(W / 2, H / 2))
      .force('collision', d3.forceCollide().radius((d: any) => rScale(d.bytes) + 4))

    const link = svg.append('g').selectAll('line').data(edges).join('line')
      .attr('stroke','#374151').attr('stroke-opacity',0.6)
      .attr('stroke-width', (d: any) => edgeScale(d.bytes))
      .attr('marker-end','url(#arrow)')

    const node = svg.append('g').selectAll('g').data(nodes).join('g')
      .call(d3.drag<any, any>()
        .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y })
        .on('drag',  (ev, d) => { d.fx=ev.x; d.fy=ev.y })
        .on('end',   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx=null; d.fy=null })
      )

    node.append('circle')
      .attr('r', (d: any) => rScale(d.bytes))
      .attr('fill', (d: any) => d.is_sampler ? '#3b82f6' : '#1e40af')
      .attr('stroke', (d: any) => d.is_sampler ? '#93c5fd' : '#3b82f6')
      .attr('stroke-width', (d: any) => d.is_sampler ? 2 : 1)

    node.append('text')
      .text((d: any) => d.sampler_name || d.id)
      .attr('dy', (d: any) => rScale(d.bytes) + 10)
      .attr('text-anchor','middle').attr('font-size',9).attr('fill','#9ca3af')

    node.append('title').text((d: any) => `${d.id}\n${fmt(d.bytes)} · ${d.flows} flows`)

    sim.on('tick', () => {
      link
        .attr('x1', (d: any) => d.source.x).attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x).attr('y2', (d: any) => d.target.y)
      node.attr('transform', (d: any) => `translate(${d.x},${d.y})`)
    })

    return () => { sim.stop() }
  }, [topology])

  if (!topology.nodes.length) return <Empty msg="No topology data" />
  return <svg ref={svgRef} className="w-full" style={{ height: 380 }} />
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function Empty({ msg }: { msg: string }) {
  return <div className="flex items-center justify-center h-32 text-white text-sm">{msg}</div>
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <h2 className="text-sm font-semibold text-white mb-3">{title}</h2>
      {children}
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function Analytics() {
  const [window, setWindow] = useState('1h')
  const [timeSeries, setTimeSeries]   = useState<TimeSeriesPoint[]>([])
  const [protocols,  setProtocols]    = useState<ProtocolStat[]>([])
  const [topology,   setTopology]     = useState<TopologyResponse>({ nodes: [], edges: [] })
  const [loading,    setLoading]      = useState(true)
  const [metric,     setMetric]       = useState<'bytes'|'packets'|'flow_count'>('bytes')

  useEffect(() => {
    setLoading(true)
    Promise.all([
      api.getTimeSeries({ window }),
      api.getProtocolStats({ window }),
      api.getTopology({ window, limit: '60' }),
    ]).then(([ts, proto, topo]) => {
      setTimeSeries(ts)
      setProtocols(proto)
      setTopology(topo)
    }).catch(console.error).finally(() => setLoading(false))
  }, [window])

  const tsData = useMemo(() =>
    timeSeries.map(p => ({ ...p, t: fmtTime(p.timestamp, window) })),
    [timeSeries, window]
  )

  const metricLabel = { bytes: 'Bytes', packets: 'Packets', flow_count: 'Flows' }[metric]

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-white">Analytics</h1>
        <div className="flex items-center gap-2">
          {loading && <span className="text-xs text-white animate-pulse">Loading…</span>}
          <div className="flex bg-gray-800 rounded-lg p-0.5 gap-0.5">
            {WINDOWS.map(w => (
              <button
                key={w}
                onClick={() => setWindow(w)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  window === w ? 'bg-blue-600 text-white' : 'text-white hover:text-white'
                }`}
              >{w}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Area chart — full width */}
      <Card title="Traffic Over Time">
        <div className="flex gap-2 mb-3">
          {(['bytes','packets','flow_count'] as const).map(m => (
            <button key={m} onClick={() => setMetric(m)}
              className={`px-2 py-0.5 rounded text-xs ${metric===m ? 'bg-blue-600 text-white' : 'text-white hover:text-gray-200'}`}>
              {metricLabel === { bytes:'Bytes', packets:'Packets', flow_count:'Flows' }[m] ? metricLabel : { bytes:'Bytes', packets:'Packets', flow_count:'Flows' }[m]}
            </button>
          ))}
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={tsData} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
            <defs>
              <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis dataKey="t" tick={{ fill:'#6b7280', fontSize:10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
            <YAxis tick={{ fill:'#6b7280', fontSize:10 }} tickLine={false} axisLine={false}
              tickFormatter={v => metric === 'bytes' ? fmt(v) : fmt(v, 'flows')} />
            <Tooltip
              contentStyle={{ background:'#111827', border:'1px solid #374151', borderRadius:8, fontSize:12 }}
              labelStyle={{ color:'#9ca3af' }}
              formatter={(v: number) => [metric === 'bytes' ? fmt(v) : fmt(v, 'flows'), metricLabel]}
            />
            <Area type="monotone" dataKey={metric} stroke="#3b82f6" fill="url(#areaGrad)" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </Card>

      {/* Pie + Sankey row */}
      <div className="grid grid-cols-5 gap-4">
        {/* Pie chart */}
        <div className="col-span-2">
          <Card title="Protocol Distribution">
            {protocols.length === 0
              ? <Empty msg="No protocol data" />
              : (
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie
                      data={protocols}
                      dataKey="bytes"
                      nameKey="name"
                      cx="50%"
                      cy="45%"
                      outerRadius={90}
                      innerRadius={45}
                      paddingAngle={2}
                      label={({ name, pct_bytes }) => `${name} ${pct_bytes}%`}
                      labelLine={false}
                    >
                      {protocols.map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ background:'#111827', border:'1px solid #374151', borderRadius:8, fontSize:12 }}
                      formatter={(v: number, name: string) => [fmt(v), name]}
                    />
                    <Legend
                      formatter={(v) => <span style={{ color:'#9ca3af', fontSize:11 }}>{v}</span>}
                      iconSize={8}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )
            }
          </Card>
        </div>

        {/* Sankey */}
        <div className="col-span-3">
          <Card title="Traffic Flow — Source → Destination">
            <SankeyChart topology={topology} />
          </Card>
        </div>
      </div>

      {/* Node-link network map */}
      <Card title="Network Map — Node-Link Graph  (drag to rearrange · blue = sampler)">
        <NetworkMap topology={topology} />
      </Card>
    </div>
  )
}
