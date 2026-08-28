"""
pktFlow — Widget endpoints for pktHub NOC Builder integration.

Manifest: GET /api/widgets/manifest  → list of widget definitions
Views:    GET /api/widgets/{type}     → server-rendered HTML page (iframe target)

Flow data is sourced from ClickHouse; alert/device data from SQLite.
"""
from __future__ import annotations
import asyncio, html, ipaddress, json, urllib.request
from pathlib import Path

import aiosqlite
from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse
from app.config import get_settings
from app.dependencies import require_suite_token

# These views are embedded as unauthenticated iframes by pktHub's NOC
# Builder, so they can't require a login session — but they do render
# internal flow/alert/device data, so every route on this router requires
# a valid X-Suite-Token (same trusted-proxy secret pktHub already sends on
# every proxied request per app/api/suite.py's docstring).
router   = APIRouter(dependencies=[Depends(require_suite_token)])
_s       = get_settings()
_DB      = _s.db_path

# ── Manifest ──────────────────────────────────────────────────────────────────
MANIFEST = [
    {"id":"top_talkers",       "title":"Top Talkers",        "description":"Highest-volume source/destination pairs",               "view_path":"/api/widgets/top_talkers",       "default_w":640,"default_h":380,"min_w":320,"min_h":200},
    {"id":"flow_summary",      "title":"Flow Summary",       "description":"Recent flow counts, bytes, and protocols",              "view_path":"/api/widgets/flow_summary",      "default_w":480,"default_h":300,"min_w":280,"min_h":180},
    {"id":"active_alerts",     "title":"Active Alerts",      "description":"Recent alert events across monitored flows",            "view_path":"/api/widgets/active_alerts",     "default_w":640,"default_h":360,"min_w":320,"min_h":200},
    {"id":"top_ports",         "title":"Top Ports",          "description":"Highest-traffic destination ports",                     "view_path":"/api/widgets/top_ports",         "default_w":460,"default_h":320,"min_w":260,"min_h":180},
    {"id":"protocol_breakdown","title":"Protocol Breakdown", "description":"Traffic distribution by protocol",                     "view_path":"/api/widgets/protocol_breakdown","default_w":460,"default_h":300,"min_w":260,"min_h":180},
    {"id":"geo_map",           "title":"Geo Map",            "description":"Live world map showing traffic origins & destinations", "view_path":"/api/widgets/geo_map",          "default_w":860,"default_h":500,"min_w":480,"min_h":300},
    {"id":"recent_flows",      "title":"Recent Flows",       "description":"Latest flow records — source, destination, protocol",  "view_path":"/api/widgets/recent_flows",      "default_w":700,"default_h":380,"min_w":360,"min_h":220},
    {"id":"network_topology",  "title":"Network Topology",   "description":"Top network nodes by traffic volume",                  "view_path":"/api/widgets/network_topology",  "default_w":540,"default_h":380,"min_w":300,"min_h":220},
    {"id":"collector_status",  "title":"Collector Status",   "description":"NetFlow collector/exporter device health",             "view_path":"/api/widgets/collector_status",  "default_w":540,"default_h":320,"min_w":300,"min_h":200},
]

@router.get("/widgets/manifest")
async def widget_manifest():
    return MANIFEST


# ── ClickHouse helper ─────────────────────────────────────────────────────────
def _ch(query: str) -> list:
    """Run a ClickHouse query synchronously. Use via asyncio.to_thread."""
    try:
        from clickhouse_driver import Client
        s = get_settings()
        c = Client(host=s.clickhouse_host, port=s.clickhouse_port,
                   database=s.clickhouse_database,
                   user=s.clickhouse_user, password=s.clickhouse_password,
                   connect_timeout=5, send_receive_timeout=10)
        try:
            return c.execute(query)
        finally:
            c.disconnect()
    except Exception:
        return []


PROTO = {1:"ICMP",6:"TCP",17:"UDP",47:"GRE",50:"ESP",51:"AH",58:"ICMPv6",89:"OSPF",132:"SCTP"}
def _pname(p):
    try: return PROTO.get(int(p or 0), str(p) if p else "?")
    except Exception: return str(p) if p else "?"


# ── Shared rendering helpers ──────────────────────────────────────────────────
def _page(title: str, body: str, extra_head: str = "") -> str:
    return f"""<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>{extra_head}
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:#0a1628;color:#e2e8f0;font-family:'Inter',system-ui,sans-serif;font-size:13px;height:100vh;overflow:hidden;display:flex;flex-direction:column}}
.hdr{{padding:8px 14px;border-bottom:1px solid #1e293b;display:flex;align-items:center;gap:8px;flex-shrink:0;height:36px}}
.hdr-dot{{width:6px;height:6px;border-radius:50%;background:#60a5fa;flex-shrink:0}}
.hdr-title{{font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:0.03em}}
.content{{flex:1;overflow:auto;padding:12px}}
table{{width:100%;border-collapse:collapse}}
th{{text-align:left;font-size:10px;color:#475569;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;padding:4px 8px;border-bottom:1px solid #1e293b}}
td{{padding:6px 8px;border-bottom:1px solid #0f172a;font-size:12px;color:#cbd5e1}}
tr:hover td{{background:#111827}}
.badge{{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600}}
.bl{{background:#172554;color:#60a5fa}}.br{{background:#3f1515;color:#f87171}}
.by{{background:#422006;color:#fbbf24}}.bg{{background:#052e16;color:#4ade80}}
.empty{{text-align:center;padding:40px;color:#334155;font-size:12px}}
.bar-row{{display:flex;align-items:center;gap:8px;margin-bottom:8px}}
.bar-lbl{{font-size:11px;color:#94a3b8;width:80px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
.bar-trk{{flex:1;background:#1e293b;border-radius:3px;height:8px;overflow:hidden}}
.bar-fill{{height:8px;border-radius:3px;background:#60a5fa}}
.bar-val{{font-size:10px;color:#475569;width:52px;text-align:right;flex-shrink:0}}
</style>
<script>setTimeout(()=>location.reload(),30000)</script>
</head><body>{body}</body></html>"""

def _fmt_bytes(b):
    if not b: return "0 B"
    if b >= 1_073_741_824: return f"{b/1_073_741_824:.1f} GB"
    if b >= 1_048_576:     return f"{b/1_048_576:.1f} MB"
    if b >= 1_024:         return f"{b/1_024:.1f} KB"
    return f"{b} B"

def _fmt_ts(ts):
    if not ts: return "—"
    return str(ts)[:19].replace("T", " ")

def _fmt_n(n):
    n = n or 0
    if n >= 1_000_000: return f"{n/1_000_000:.1f}M"
    if n >= 1_000:     return f"{n/1_000:.1f}K"
    return str(n)


# ── Top Talkers ───────────────────────────────────────────────────────────────
@router.get("/widgets/top_talkers", response_class=HTMLResponse, include_in_schema=False)
async def widget_top_talkers():
    rows = await asyncio.to_thread(_ch, """
        SELECT src_ip, dst_ip, protocol, sum(bytes) as total_bytes, count() as flow_count
        FROM flows
        WHERE timestamp >= now() - INTERVAL 10 MINUTE
        GROUP BY src_ip, dst_ip, protocol
        ORDER BY total_bytes DESC
        LIMIT 20
    """)
    if rows:
        trs = "".join(
            f"<tr><td>{html.escape(str(r[0]))}</td><td>{html.escape(str(r[1]))}</td>"
            f"<td><span class='badge bl'>{html.escape(_pname(r[2]))}</span></td>"
            f"<td>{_fmt_bytes(r[3] or 0)}</td><td>{r[4]}</td></tr>"
            for r in rows
        )
        content = f"<table><thead><tr><th>Source</th><th>Destination</th><th>Proto</th><th>Bytes</th><th>Flows</th></tr></thead><tbody>{trs}</tbody></table>"
    else:
        content = "<div class='empty'>No recent flow data</div>"
    body = f"<div class='hdr'><div class='hdr-dot'></div><span class='hdr-title'>Top Talkers — last 10 min</span></div><div class='content'>{content}</div>"
    return HTMLResponse(_page("Top Talkers", body))


# ── Flow Summary ──────────────────────────────────────────────────────────────
@router.get("/widgets/flow_summary", response_class=HTMLResponse, include_in_schema=False)
async def widget_flow_summary():
    stats_rows = await asyncio.to_thread(_ch, """
        SELECT count() as total_flows, sum(bytes) as total_bytes,
               uniq(src_ip) as unique_src, uniq(dst_ip) as unique_dst
        FROM flows WHERE timestamp >= now() - INTERVAL 10 MINUTE
    """)
    proto_rows = await asyncio.to_thread(_ch, """
        SELECT protocol, count() as cnt, sum(bytes) as bytes
        FROM flows WHERE timestamp >= now() - INTERVAL 10 MINUTE
        GROUP BY protocol ORDER BY cnt DESC LIMIT 8
    """)
    s = stats_rows[0] if stats_rows else (0, 0, 0, 0)
    cards = f"""<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
<div style="background:#111827;border:1px solid #1e293b;border-radius:8px;padding:10px"><div style="font-size:10px;color:#475569;margin-bottom:4px">Flows (10 min)</div><div style="font-size:20px;font-weight:700;color:#60a5fa">{_fmt_n(s[0])}</div></div>
<div style="background:#111827;border:1px solid #1e293b;border-radius:8px;padding:10px"><div style="font-size:10px;color:#475569;margin-bottom:4px">Bytes (10 min)</div><div style="font-size:20px;font-weight:700;color:#2dd4bf">{_fmt_bytes(s[1] or 0)}</div></div>
<div style="background:#111827;border:1px solid #1e293b;border-radius:8px;padding:10px"><div style="font-size:10px;color:#475569;margin-bottom:4px">Unique Sources</div><div style="font-size:20px;font-weight:700;color:#a78bfa">{_fmt_n(s[2])}</div></div>
<div style="background:#111827;border:1px solid #1e293b;border-radius:8px;padding:10px"><div style="font-size:10px;color:#475569;margin-bottom:4px">Unique Dest</div><div style="font-size:20px;font-weight:700;color:#f472b6">{_fmt_n(s[3])}</div></div>
</div>"""
    if proto_rows:
        trs = "".join(
            f"<tr><td><span class='badge bl'>{_pname(r[0])}</span></td>"
            f"<td>{_fmt_n(r[1])}</td><td>{_fmt_bytes(r[2] or 0)}</td></tr>"
            for r in proto_rows
        )
        table = f"<table><thead><tr><th>Protocol</th><th>Flows</th><th>Bytes</th></tr></thead><tbody>{trs}</tbody></table>"
    else:
        table = "<div class='empty'>No recent flow data</div>"
    body = f"<div class='hdr'><div class='hdr-dot' style='background:#2dd4bf'></div><span class='hdr-title'>Flow Summary — last 10 min</span></div><div class='content'>{cards}{table}</div>"
    return HTMLResponse(_page("Flow Summary", body))


# ── Active Alerts (from SQLite) ───────────────────────────────────────────────
@router.get("/widgets/active_alerts", response_class=HTMLResponse, include_in_schema=False)
async def widget_active_alerts():
    rows = []
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("""
                SELECT fired_at as ts, severity, message
                FROM alert_events
                ORDER BY fired_at DESC LIMIT 30
            """) as cur:
                rows = [dict(r) for r in await cur.fetchall()]
    except Exception:
        pass
    SEV = {"critical":"#f87171","high":"#fb923c","warning":"#fbbf24","medium":"#fbbf24","low":"#4ade80","info":"#60a5fa"}
    if rows:
        trs = []
        for r in rows:
            sev = str(r.get("severity","info")).lower()
            c = SEV.get(sev,"#94a3b8")
            trs.append(
                f"<tr><td style='font-size:10px;color:#475569'>{html.escape(_fmt_ts(r.get('ts','')))}</td>"
                f"<td><span class='badge' style='background:#1e293b;color:{c}'>{html.escape(sev.upper())}</span></td>"
                f"<td style='color:#e2e8f0'>{html.escape(str(r.get('message',''))[:80])}</td></tr>"
            )
        content = f"<table><thead><tr><th>Time</th><th>Severity</th><th>Message</th></tr></thead><tbody>{''.join(trs)}</tbody></table>"
    else:
        content = "<div class='empty'>No recent alerts</div>"
    body = f"<div class='hdr'><div class='hdr-dot' style='background:#f87171'></div><span class='hdr-title'>Active Alerts</span></div><div class='content'>{content}</div>"
    return HTMLResponse(_page("Active Alerts", body))


# ── Top Ports ─────────────────────────────────────────────────────────────────
@router.get("/widgets/top_ports", response_class=HTMLResponse, include_in_schema=False)
async def widget_top_ports():
    rows = await asyncio.to_thread(_ch, """
        SELECT dst_port, protocol, count() as flow_count, sum(bytes) as total_bytes
        FROM flows
        WHERE timestamp >= now() - INTERVAL 10 MINUTE AND dst_port > 0
        GROUP BY dst_port, protocol
        ORDER BY flow_count DESC
        LIMIT 20
    """)
    WELL = {80:"HTTP",443:"HTTPS",22:"SSH",53:"DNS",25:"SMTP",3389:"RDP",23:"Telnet",21:"FTP",161:"SNMP",514:"Syslog",179:"BGP"}
    max_f = max((r[2] or 0 for r in rows), default=1)
    if rows:
        bars = []
        for r in rows:
            port = r[0] or 0
            svc = WELL.get(int(port),"")
            label = f"{port}" + (f" {svc}" if svc else "")
            pct = int(((r[2] or 0) / max_f) * 100)
            bars.append(f"<div class='bar-row'><span class='bar-lbl' title='{label}'>{label}</span><div class='bar-trk'><div class='bar-fill' style='width:{pct}%'></div></div><span class='bar-val'>{r[2]}</span></div>")
        content = "".join(bars)
    else:
        content = "<div class='empty'>No recent port data</div>"
    body = f"<div class='hdr'><div class='hdr-dot' style='background:#a78bfa'></div><span class='hdr-title'>Top Ports — last 10 min</span></div><div class='content'>{content}</div>"
    return HTMLResponse(_page("Top Ports", body))


# ── Protocol Breakdown ────────────────────────────────────────────────────────
@router.get("/widgets/protocol_breakdown", response_class=HTMLResponse, include_in_schema=False)
async def widget_protocol_breakdown():
    rows = await asyncio.to_thread(_ch, """
        SELECT protocol, count() as cnt, sum(bytes) as bytes
        FROM flows WHERE timestamp >= now() - INTERVAL 10 MINUTE
        GROUP BY protocol ORDER BY cnt DESC LIMIT 12
    """)
    COLORS = ["#60a5fa","#a78bfa","#4ade80","#2dd4bf","#f472b6","#fbbf24","#fb923c","#f87171","#818cf8","#34d399","#e879f9","#38bdf8"]
    total = sum(r[1] or 0 for r in rows) or 1
    if rows:
        bars = []
        for i, r in enumerate(rows):
            cnt = r[1] or 0
            pct = int((cnt / total) * 100)
            color = COLORS[i % len(COLORS)]
            bars.append(f"<div class='bar-row'><span class='bar-lbl'>{_pname(r[0])}</span><div class='bar-trk'><div class='bar-fill' style='width:{pct}%;background:{color}'></div></div><span class='bar-val'>{pct}%</span></div>")
        content = "".join(bars) + f"<div style='font-size:10px;color:#475569;margin-top:12px'>{total:,} total flows — last 10 min</div>"
    else:
        content = "<div class='empty'>No recent flow data</div>"
    body = f"<div class='hdr'><div class='hdr-dot' style='background:#4ade80'></div><span class='hdr-title'>Protocol Breakdown — last 10 min</span></div><div class='content'>{content}</div>"
    return HTMLResponse(_page("Protocol Breakdown", body))


# ── Geo Map ───────────────────────────────────────────────────────────────────
def _is_private(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
        return a.is_private or a.is_loopback or a.is_link_local or a.is_multicast or a.is_reserved or a.is_unspecified
    except ValueError:
        return True

def _fetch_geo(ips: list) -> dict:
    if not ips:
        return {}
    try:
        body = json.dumps([{"query": ip, "fields": "status,query,lat,lon,city,country"} for ip in ips[:100]]).encode()
        req  = urllib.request.Request("http://ip-api.com/batch", data=body,
                                       headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=6) as resp:
            results = json.loads(resp.read())
        return {r["query"]: {"lat": r["lat"], "lng": r["lon"], "city": r.get("city",""), "country": r.get("country","")}
                for r in results if r.get("status") == "success"}
    except Exception:
        return {}

@router.get("/widgets/geo_map", response_class=HTMLResponse, include_in_schema=False)
async def widget_geo_map():
    rows = await asyncio.to_thread(_ch, """
        SELECT src_ip, dst_ip, sum(bytes) as bytes, count() as flows
        FROM flows WHERE timestamp >= now() - INTERVAL 1 HOUR
        GROUP BY src_ip, dst_ip ORDER BY bytes DESC LIMIT 60
    """)
    pairs = [{"src_ip": str(r[0]), "dst_ip": str(r[1]), "bytes": r[2] or 0, "flows": r[3] or 0} for r in rows]
    all_ips = list({ip for p in pairs for ip in (p["src_ip"], p["dst_ip"]) if not _is_private(ip)})
    geo = await asyncio.to_thread(_fetch_geo, all_ips)

    locations = [{"ip": ip, **g, "bytes": 0} for ip, g in geo.items()]
    ip_bytes: dict = {}
    for p in pairs:
        for f in ("src_ip","dst_ip"):
            if p[f] in geo:
                ip_bytes[p[f]] = ip_bytes.get(p[f], 0) + p["bytes"]
    for loc in locations:
        loc["bytes"] = ip_bytes.get(loc["ip"], 0)

    arcs, seen = [], set()
    for p in pairs:
        sg, dg = geo.get(p["src_ip"]), geo.get(p["dst_ip"])
        if not sg or not dg:
            continue
        key = (p["src_ip"], p["dst_ip"])
        if key in seen:
            continue
        seen.add(key)
        arcs.append({"src_lat": sg["lat"], "src_lng": sg["lng"], "dst_lat": dg["lat"], "dst_lng": dg["lng"], "bytes": p["bytes"]})
    geo_json = json.dumps({"locations": locations, "arcs": arcs[:50]})

    extra_head = """<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>#map{width:100%;height:calc(100vh - 36px)}.leaflet-container{background:#0a1628!important}.leaflet-tooltip{background:#111827;border:1px solid #334155;color:#e2e8f0;font-size:11px}</style>
<script>setTimeout(()=>location.reload(),60000)</script>"""

    body = f"""<div class='hdr'><div class='hdr-dot' style='background:#2dd4bf'></div><span class='hdr-title'>Geo Map — traffic origins &amp; destinations (last 1 hr)</span></div>
<div id="map"></div>
<script>
const GD={geo_json};
const map=L.map('map',{{attributionControl:true,zoomControl:true}});
L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{{z}}/{{y}}/{{x}}',{{attribution:'Tiles &copy; Esri',maxZoom:16}}).addTo(map);
GD.arcs.forEach(a=>L.polyline([[a.src_lat,a.src_lng],[a.dst_lat,a.dst_lng]],{{color:'#60a5fa',weight:1.2,opacity:0.45}}).addTo(map));
const pts=[];
GD.locations.forEach(loc=>{{
  const r=Math.max(4,Math.min(16,Math.sqrt((loc.bytes||1)/2000)));
  L.circleMarker([loc.lat,loc.lng],{{radius:r,color:'#60a5fa',fillColor:'#60a5fa',fillOpacity:0.65,weight:1.5}})
   .bindTooltip('<b>'+loc.ip+'</b>'+(loc.city?'<br>'+loc.city+(loc.country?', '+loc.country:''):''),{{sticky:true}}).addTo(map);
  pts.push([loc.lat,loc.lng]);
}});
if(pts.length){{
  map.fitBounds(L.latLngBounds(pts),{{padding:[30,30],maxZoom:10}});
}}else{{
  map.setView([20,0],2);
  document.getElementById('map').innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#334155;font-size:13px">No public IP geo data available</div>';
}}
</script>"""
    return HTMLResponse(f"""<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Geo Map</title>{extra_head}</head><body style="margin:0;background:#0a1628;font-family:Inter,system-ui,sans-serif;display:flex;flex-direction:column;height:100vh;overflow:hidden">{body}</body></html>""")


# ── Recent Flows ──────────────────────────────────────────────────────────────
@router.get("/widgets/recent_flows", response_class=HTMLResponse, include_in_schema=False)
async def widget_recent_flows():
    rows = await asyncio.to_thread(_ch, """
        SELECT src_ip, dst_ip, protocol, dst_port, bytes, timestamp
        FROM flows ORDER BY timestamp DESC LIMIT 30
    """)
    if rows:
        trs = "".join(
            f"<tr><td style='font-size:10px;color:#475569'>{html.escape(_fmt_ts(r[5]))}</td>"
            f"<td>{html.escape(str(r[0]))}</td><td>{html.escape(str(r[1]))}</td>"
            f"<td><span class='badge bl'>{html.escape(_pname(r[2]))}</span></td>"
            f"<td style='color:#64748b'>{html.escape(str(r[3])) if r[3] else '—'}</td>"
            f"<td>{_fmt_bytes(r[4] or 0)}</td></tr>"
            for r in rows
        )
        content = f"<table><thead><tr><th>Time</th><th>Source</th><th>Destination</th><th>Proto</th><th>Port</th><th>Bytes</th></tr></thead><tbody>{trs}</tbody></table>"
    else:
        content = "<div class='empty'>No flow records available</div>"
    body = f"<div class='hdr'><div class='hdr-dot' style='background:#38bdf8'></div><span class='hdr-title'>Recent Flows</span></div><div class='content'>{content}</div>"
    return HTMLResponse(_page("Recent Flows", body))


# ── Network Topology ──────────────────────────────────────────────────────────
@router.get("/widgets/network_topology", response_class=HTMLResponse, include_in_schema=False)
async def widget_network_topology():
    rows = await asyncio.to_thread(_ch, """
        SELECT ip, sum(bytes) as total_bytes, sum(flows) as total_flows, uniq(peer) as peer_count
        FROM (
            SELECT src_ip as ip, dst_ip as peer, sum(bytes) as bytes, count() as flows
            FROM flows WHERE timestamp >= now() - INTERVAL 1 HOUR
            GROUP BY src_ip, dst_ip
            UNION ALL
            SELECT dst_ip as ip, src_ip as peer, sum(bytes) as bytes, count() as flows
            FROM flows WHERE timestamp >= now() - INTERVAL 1 HOUR
            GROUP BY dst_ip, src_ip
        )
        GROUP BY ip ORDER BY total_bytes DESC LIMIT 20
    """)
    max_b = max((r[1] or 0 for r in rows), default=1)
    if rows:
        trs = []
        for r in rows:
            pct = int(((r[1] or 0) / max_b) * 100)
            bar = f"<div style='background:#1e293b;border-radius:2px;height:6px;width:80px;display:inline-block;vertical-align:middle;margin-right:6px'><div style='background:#60a5fa;height:6px;border-radius:2px;width:{pct}%'></div></div>"
            trs.append(f"<tr><td style='font-family:monospace;font-size:11px'>{html.escape(str(r[0]))}</td><td>{bar}{_fmt_bytes(r[1] or 0)}</td><td style='color:#64748b'>{r[2] or 0}</td><td style='color:#64748b'>{r[3] or 0}</td></tr>")
        content = f"<table><thead><tr><th>IP Address</th><th>Traffic (1 hr)</th><th>Flows</th><th>Peers</th></tr></thead><tbody>{''.join(trs)}</tbody></table>"
    else:
        content = "<div class='empty'>No topology data</div>"
    body = f"<div class='hdr'><div class='hdr-dot' style='background:#818cf8'></div><span class='hdr-title'>Network Topology — top nodes (1 hr)</span></div><div class='content'>{content}</div>"
    return HTMLResponse(_page("Network Topology", body))


# ── Collector Status ──────────────────────────────────────────────────────────
@router.get("/widgets/collector_status", response_class=HTMLResponse, include_in_schema=False)
async def widget_collector_status():
    # Per-sampler stats from ClickHouse
    ch_rows = await asyncio.to_thread(_ch, """
        SELECT sampler_ip, sampler_name, sum(bytes) as bytes, max(timestamp) as last_seen
        FROM flows WHERE timestamp >= now() - INTERVAL 1 HOUR
        GROUP BY sampler_ip, sampler_name ORDER BY bytes DESC
    """)
    # Device names from SQLite registry
    dev_names: dict = {}
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("SELECT ip, name, site FROM devices") as cur:
                for row in await cur.fetchall():
                    dev_names[str(row["ip"])] = f"{row['name']} ({row['site']})" if row.get("site") else str(row["name"])
    except Exception:
        pass

    if ch_rows:
        trs = []
        for r in ch_rows:
            ip  = str(r[0])
            name = dev_names.get(ip, str(r[1] or ""))
            last = _fmt_ts(r[3])
            trs.append(
                f"<tr>"
                f"<td><span style='display:inline-block;width:7px;height:7px;border-radius:50%;background:#4ade80;margin-right:6px'></span>{html.escape(ip)}</td>"
                f"<td style='color:#64748b;font-size:11px'>{html.escape(name)}</td>"
                f"<td>{_fmt_bytes(r[2] or 0)}</td>"
                f"<td style='font-size:10px;color:#475569'>{html.escape(last)}</td></tr>"
            )
        content = f"<table><thead><tr><th>Sampler</th><th>Name/Site</th><th>Traffic (1 hr)</th><th>Last Seen</th></tr></thead><tbody>{''.join(trs)}</tbody></table>"
    else:
        content = "<div class='empty'>No collector data (no flows in last hour)</div>"
    body = f"<div class='hdr'><div class='hdr-dot' style='background:#34d399'></div><span class='hdr-title'>Collector Status</span></div><div class='content'>{content}</div>"
    return HTMLResponse(_page("Collector Status", body))
