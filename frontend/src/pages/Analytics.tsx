/**
 * Analytics — visual data exploration
 * Four chart types: area, pie, Sankey, node-link network map
 */
import { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import * as d3 from 'd3'
import { api, TimeSeriesPoint, TopologyResponse } from '../api/client'
import { RadarCard } from './Radar'
import { useWebSocket, type WsMessage, type IngestStats } from '../hooks/useWebSocket'
import HelpButton from '../components/HelpButton'
import { axisProps, tooltipProps, gridProps, glow, INSTRUMENT, FlowDefs, NodeRail, InstrumentFrame, RadialRing, liveEdgeDot , LinePulseGradient } from '../components/instrument'

// ── Colour palette ─────────────────────────────────────────────────────────────
const COLORS = ['#ab9017','#007dab','#d86353','#00a49e','#8561bd','#007b43','#466cc8','#be7125']

const WINDOWS = ['1h','6h','24h','7d','30d']
const HIST_WINDOWS = [
  { label: '7d',  days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
]

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
  const srcIdx = new Set(links.map(l => l.source))
  const dstIdx = new Set(links.map(l => l.target))

  const nodeW = 14
  const colX = { src: 20, dst: width - 20 - nodeW }

  const srcTotals = new Map<number, number>()
  const dstTotals = new Map<number, number>()
  links.forEach(l => {
    srcTotals.set(l.source, (srcTotals.get(l.source) ?? 0) + l.value)
    dstTotals.set(l.target, (dstTotals.get(l.target) ?? 0) + l.value)
  })

  const totalVal = links.reduce((s, l) => s + l.value, 0) || 1
  const usableH = height - padding * 2

  let y = padding
  const positioned: (SankeyNode & { x: number; y: number; h: number; value: number })[] = new Array(nodes.length)
  const srcList = [...srcIdx].sort((a, b) => (srcTotals.get(b) ?? 0) - (srcTotals.get(a) ?? 0))
  const srcH = (usableH - padding * (srcList.length - 1)) / srcList.length
  srcList.forEach(i => {
    positioned[i] = { ...nodes[i], x: colX.src, y, h: Math.max(srcH, 4), value: srcTotals.get(i) ?? 0 }
    y += srcH + padding
  })

  y = padding
  const dstList = [...dstIdx].sort((a, b) => (dstTotals.get(b) ?? 0) - (dstTotals.get(a) ?? 0))
  const dstH = (usableH - padding * (dstList.length - 1)) / dstList.length
  dstList.forEach(i => {
    positioned[i] = { ...nodes[i], x: colX.dst, y, h: Math.max(dstH, 4), value: dstTotals.get(i) ?? 0 }
    y += dstH + padding
  })

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
    // The ribbon body, plus its centreline — the centreline carries the
    // travelling dash that shows direction, so it must follow the same curve.
    const cy0 = y0 + linkH / 2
    const cy1 = y1 + linkH / 2
    return {
      d: `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1} L${x1},${y1+linkH} C${mx},${y1+linkH} ${mx},${y0+linkH} ${x0},${y0+linkH} Z`,
      mid: `M${x0},${cy0} C${mx},${cy0} ${mx},${cy1} ${x1},${cy1}`,
      value: l.value,
      source: l.source,
      target: l.target,
      h: linkH,
    }
  })

  return { positioned, paths }
}

function SankeyChart({ topology }: { topology: TopologyResponse }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ w: 760, h: 340 })

  useEffect(() => {
    if (!containerRef.current) return
    const obs = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width > 50 && height > 50) setDims({ w: width, h: height })
    })
    obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [])

  const { nodes, links } = useMemo(() => {
    const top = topology.edges.slice(0, 20)
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

  const { W, H } = { W: dims.w, H: dims.h }
  const { positioned, paths } = buildSankeyLayout(nodes, links, W, H)

  const ribbons = paths.map((p, i) => ({
    from: COLORS[(p ? p.source : i) % COLORS.length],
    to:   COLORS[(p ? p.target : i) % COLORS.length],
  }))

  // Dash speed carries the ribbon's throughput: the busiest link runs fastest.
  // Scaled against the busiest ribbon in view rather than an absolute rate, so
  // the comparison is between links on screen — it reads as "this one is
  // moving more than that one", not as an absolute bytes/sec.
  const maxVal = Math.max(1, ...paths.filter(Boolean).map(p => (p as any).value))
  const FAST_S = 1.6, SLOW_S = 9   // seconds per dash cycle
  const flowDuration = (value: number) => {
    const frac = Math.min(1, Math.max(0, value / maxVal))
    // sqrt keeps mid-sized flows visibly different rather than all near-slow
    return `${(SLOW_S - Math.sqrt(frac) * (SLOW_S - FAST_S)).toFixed(2)}s`
  }

  return (
    <div ref={containerRef} className="w-full h-full relative">
      <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
        <FlowDefs ribbons={ribbons} />

        {/* ribbons: volume in the width, direction in the travelling dash */}
        {paths.map((p, i) => p && (
          <g key={i}>
            <path d={p.d} fill={`url(#f-ribbon-${i})`}>
              <title>{fmt(p.value)}</title>
            </path>
            <path
              d={p.mid}
              fill="none"
              stroke={COLORS[p.source % COLORS.length]}
              strokeWidth={Math.min(Math.max(p.h * 0.34, 0.8), 3)}
              strokeLinecap="round"
              opacity={0.9}
              className="f-ribbon-pulse"
              filter="url(#f-ribbon-glow)"
              style={{
                animationDelay: `${(i % 7) * 0.45}s`,
                animationDuration: flowDuration(p.value),
              }}
            />
          </g>
        ))}

        {/* endpoints as instrument rails rather than filled blocks */}
        {positioned.filter(Boolean).map((n, i) => (
          <g key={i}>
            <NodeRail
              x={n.x < W / 2 ? n.x + 10 : n.x}
              y={n.y}
              h={Math.max(n.h, 4)}
              color={COLORS[i % COLORS.length]}
              side={n.x < W / 2 ? 'src' : 'dst'}
            />
            <text
              x={n.x < W/2 ? n.x + 20 : n.x - 6}
              y={n.y + n.h / 2}
              textAnchor={n.x < W/2 ? 'start' : 'end'}
              dominantBaseline="middle"
              fontSize={9.5}
              fontFamily="ui-monospace, SF Mono, Menlo, monospace"
              fill={INSTRUMENT.ink}
              opacity={0.82}
            >{n.name}</text>
          </g>
        ))}
      </svg>

      {/* width = volume, dash speed = throughput */}
      <div className="absolute bottom-0 left-0 flex items-center gap-3 pointer-events-none flex-wrap">
        <div className="flex items-center gap-2">
          <span className="f-lbl">source</span>
          <span className="h-px w-8" style={{ background: 'linear-gradient(90deg, rgba(216,180,110,.5), rgba(138,216,234,.5))' }} />
          <span className="f-lbl">destination</span>
        </div>
        <span className="f-lbl" style={{ opacity: 0.75 }}>· width = volume · dash speed = rate</span>
      </div>
    </div>
  )
}

// ── Node-link network map (D3) ─────────────────────────────────────────────────
function NetworkMap({ topology }: { topology: TopologyResponse }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [dims, setDims] = useState({ w: 760, h: 380 })

  useEffect(() => {
    if (!containerRef.current) return
    const obs = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width > 50 && height > 50) setDims({ w: width, h: height })
    })
    obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    if (!svgRef.current || !topology.nodes.length) return
    const W = dims.w, H = dims.h

    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const defs = svg.append('defs')
    defs.append('marker').attr('id','arrow').attr('viewBox','0 -4 8 8')
      .attr('refX',16).attr('refY',0).attr('markerWidth',6).attr('markerHeight',6)
      .attr('orient','auto')
      .append('path').attr('d','M0,-4L8,0L0,4').attr('fill','#5c6470')

    const g = svg.append('g')

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 8])
      .on('zoom', (ev) => g.attr('transform', ev.transform))

    svg.call(zoom).on('dblclick.zoom', null)

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

    const link = g.append('g').selectAll('line').data(edges).join('line')
      .attr('stroke','#2a2418').attr('stroke-opacity',0.6)
      .attr('stroke-width', (d: any) => edgeScale(d.bytes))
      .attr('marker-end','url(#arrow)')

    const node = g.append('g').selectAll('g').data(nodes).join('g')
      .call(d3.drag<any, any>()
        .on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y })
        .on('drag',  (ev, d) => { d.fx=ev.x; d.fy=ev.y })
        .on('end',   (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx=null; d.fy=null })
      )

    node.append('circle')
      .attr('r', (d: any) => rScale(d.bytes))
      .attr('fill', (d: any) => d.is_sampler ? '#8ad8ea' : '#466cc8')
      .attr('stroke', (d: any) => d.is_sampler ? '#63c3d8' : '#8ad8ea')
      .attr('stroke-width', (d: any) => d.is_sampler ? 2 : 1)

    node.append('text')
      .text((d: any) => d.sampler_name || d.id)
      .attr('dy', (d: any) => rScale(d.bytes) + 10)
      .attr('text-anchor','middle').attr('font-size',9).attr('fill','#a9a294')

    node.append('title').text((d: any) => `${d.id}\n${fmt(d.bytes)} · ${d.flows} flows`)

    sim.on('tick', () => {
      link
        .attr('x1', (d: any) => d.source.x).attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x).attr('y2', (d: any) => d.target.y)
      node.attr('transform', (d: any) => `translate(${d.x},${d.y})`)
    })

    const controls = svg.append('g').attr('transform', `translate(${W - 58}, 10)`)
    const btnData = [{ label: '+', dy: 0, fn: () => svg.transition().duration(200).call(zoom.scaleBy, 1.4) },
                     { label: '−', dy: 28, fn: () => svg.transition().duration(200).call(zoom.scaleBy, 0.7) },
                     { label: '⤢', dy: 56, fn: () => svg.transition().duration(300).call(zoom.transform, d3.zoomIdentity) }]
    btnData.forEach(({ label, dy, fn }) => {
      const btn = controls.append('g').attr('transform', `translate(0,${dy})`).style('cursor','pointer').on('click', fn)
      btn.append('rect').attr('width', 22).attr('height', 22).attr('rx', 4)
        .attr('fill','#211c14').attr('stroke','#2a2418').attr('stroke-width', 0.5)
      btn.append('text').text(label).attr('x', 11).attr('y', 15)
        .attr('text-anchor','middle').attr('font-size', 13).attr('fill','#a9a294')
    })

    return () => { sim.stop() }
  }, [topology, dims])

  if (!topology.nodes.length) return <Empty msg="No topology data" />
  return (
    <div ref={containerRef} className="w-full h-full">
      <svg ref={svgRef} className="w-full h-full" style={{ cursor: 'grab' }} />
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function Empty({ msg }: { msg: string }) {
  return <div className="flex items-center justify-center h-32 text-white text-sm">{msg}</div>
}

function Card({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-gray-900 rounded-xl border border-gray-800 p-4 flex flex-col ${className}`}>
      <h2 className="text-sm font-semibold text-white mb-3 flex-shrink-0">{title}</h2>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function Analytics() {
  const [window, setWindow] = useState('1h')
  const [timeSeries, setTimeSeries] = useState<TimeSeriesPoint[]>([])
  const [topology,   setTopology]   = useState<TopologyResponse>({ nodes: [], edges: [] })
  const [loading,    setLoading]    = useState(true)
  const [metric,     setMetric]     = useState<'bytes'|'packets'|'flow_count'>('bytes')
  const [histDays,   setHistDays]   = useState(7)
  const [dailyData,  setDailyData]  = useState<TimeSeriesPoint[]>([])
  const [wsStats,    setWsStats]    = useState<IngestStats | null>(null)

  const handleWsMessage = useCallback((msg: WsMessage) => {
    if (msg.type === 'ingest_stats') setWsStats(msg.data)
  }, [])

  const { connected: wsConnected } = useWebSocket(handleWsMessage)

  useEffect(() => {
    setLoading(true)
    Promise.allSettled([
      api.getTimeSeries({ window }),
      api.getTopology({ window, limit: '60' }),
    ]).then(([tsResult, topoResult]) => {
      if (tsResult.status === 'fulfilled') setTimeSeries(tsResult.value)
      else console.error('timeseries failed:', tsResult.reason)
      if (topoResult.status === 'fulfilled') setTopology(topoResult.value)
      else console.error('topology failed:', topoResult.reason)
    }).finally(() => setLoading(false))
  }, [window])

  useEffect(() => {
    api.getDailyTimeseries(histDays).then(setDailyData).catch(console.error)
  }, [histDays])

  const tsData = useMemo(() =>
    timeSeries.map(p => ({ ...p, t: fmtTime(p.timestamp, window) })),
    [timeSeries, window]
  )

  const metricLabel = { bytes: 'Bytes', packets: 'Packets', flow_count: 'Flows' }[metric]

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-white">Dashboard</h1>
            <HelpButton title="Dashboard — How It Works">
              <p>The <span className="text-gray-300 font-medium">1h/6h/24h/7d/30d</span> window picker at top right drives Traffic Over Time and the top-talkers/protocol cards — all short-range, queried straight from raw flow records.</p>
              <p><span className="text-gray-300 font-medium">Historical Trend</span> is separate and always long-range (7d/30d/90d) — it reads from hourly rollups instead of raw flows, which is what keeps it fast even over 90 days of data.</p>
              <p><span className="text-gray-300 font-medium">Live</span> badge means flow data is arriving over WebSocket in real time; if it's absent the page falls back to periodic polling — data is still current, just not push-driven.</p>
            </HelpButton>
          </div>
          {wsConnected && (
            <span className="flex items-center gap-1.5 text-xs text-green-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              Live
            </span>
          )}
          {wsStats && wsConnected && (
            <span className="text-xs text-white">
              {wsStats.total_flushed.toLocaleString()} flows ingested
            </span>
          )}
        </div>
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


      {/* Traffic Over Time + Historical Trend side by side */}
      <div className="grid grid-cols-2 gap-4 flex-shrink-0">
        <Card title="Traffic Over Time">
          <div className="flex gap-2 mb-3">
            {(['bytes','packets','flow_count'] as const).map(m => (
              <button key={m} onClick={() => setMetric(m)}
                className={`px-2 py-0.5 rounded text-xs ${metric===m ? 'bg-blue-600 text-white' : 'text-white hover:text-gray-200'}`}>
                {({ bytes:'Bytes', packets:'Packets', flow_count:'Flows' } as const)[m]}
              </button>
            ))}
          </div>
          <InstrumentFrame height={180} live>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={tsData} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
              <defs>
                <LinePulseGradient id="f-pulse-traffic" color="#8ad8ea" />
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#8ad8ea" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#8ad8ea" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="t" tick={axisProps.tick} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis tick={axisProps.tick} tickLine={false} axisLine={false}
                tickFormatter={v => metric === 'bytes' ? fmt(v) : fmt(v, 'flows')} />
              <Tooltip
                contentStyle={tooltipProps.contentStyle}
                labelStyle={tooltipProps.labelStyle}
                formatter={(v: number) => [metric === 'bytes' ? fmt(v) : fmt(v, 'flows'), metricLabel]}
              />
              <Area type="monotone" dataKey={metric} stroke="url(#f-pulse-traffic)" style={glow("#8ad8ea", 5)}
                    fill="url(#areaGrad)" strokeWidth={2}
                    dot={liveEdgeDot(tsData.length, '#8ad8ea')} activeDot={{ r: 3, strokeWidth: 0, fill: '#8ad8ea' }} />
            </AreaChart>
          </ResponsiveContainer>
        </InstrumentFrame>
        </Card>

        <Card title="Historical Trend — Daily Traffic">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-gray-500">Bytes per day</span>
            <div className="flex bg-gray-800 rounded-lg p-0.5 gap-0.5">
              {HIST_WINDOWS.map(w => (
                <button key={w.days} onClick={() => setHistDays(w.days)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    histDays === w.days ? 'bg-blue-600 text-white' : 'text-white hover:text-white'
                  }`}>{w.label}</button>
              ))}
            </div>
          </div>
          {dailyData.length < 1 ? (
            <div className="flex items-center justify-center h-[180px] text-xs text-gray-500">
              Accumulating data…
            </div>
          ) : (
            <InstrumentFrame height={180} live>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={(() => {
                // Zero-fill: build one entry per day in the selected range so the
                // X-axis spans the full window even when early days have no data.
                const byDay = new Map(dailyData.map(p => {
                  const d = new Date(p.timestamp)
                  const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`
                  return [key, p]
                }))
                const filled = []
                for (let i = histDays - 1; i >= 0; i--) {
                  const d = new Date()
                  d.setUTCDate(d.getUTCDate() - i)
                  const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`
                  const p = byDay.get(key)
                  filled.push({
                    t: d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
                    bytes: p ? p.bytes : 0,
                    flows: p ? p.flow_count : 0,
                  })
                }
                return filled
              })()} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
                <defs>
                  <LinePulseGradient id="f-pulse-hist" color="#7ee0a8" />
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 <linearGradient id="histGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#7ee0a8" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#7ee0a8" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="t" tick={axisProps.tick} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                <YAxis tick={axisProps.tick} tickLine={false} axisLine={false} tickFormatter={v => fmt(v)} />
                <Tooltip
                  contentStyle={tooltipProps.contentStyle}
                  labelStyle={tooltipProps.labelStyle}
                  formatter={(v: number) => [fmt(v), 'Bytes']}
                />
                <Area type="monotone" dataKey="bytes" stroke="url(#f-pulse-hist)" style={glow("#7ee0a8", 5)}
                      fill="url(#histGrad)" strokeWidth={2}
                      dot={liveEdgeDot(histDays, '#7ee0a8')} activeDot={{ r: 3, strokeWidth: 0, fill: '#7ee0a8' }} />
              </AreaChart>
            </ResponsiveContainer>
        </InstrumentFrame>
          )}
        </Card>
      </div>

      {/* Network map + Traffic flow — expands to fill remaining height */}
      <div className="grid grid-cols-2 gap-4 flex-1 min-h-0">
        <RadarCard timeWindow={window} />
        <Card title="Traffic Flow — Source → Destination" className="h-full">
          <SankeyChart topology={topology} />
        </Card>
      </div>
    </div>
  )
}
