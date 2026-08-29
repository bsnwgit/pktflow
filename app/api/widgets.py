"""
pktFlow — Widget endpoints for pktHub NOC Builder integration.

Manifest: GET /api/widgets/manifest  → list of widget definitions
Views:    GET /api/widgets/{type}     → server-rendered HTML page (iframe target)

Flow data is sourced from ClickHouse; alert/device data from SQLite.
"""
from __future__ import annotations
import asyncio, html, ipaddress, json, math, urllib.request
from contextvars import ContextVar
from pathlib import Path

import aiosqlite
from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from app.config import get_settings
from app.dependencies import require_suite_token

# These views are embedded as unauthenticated iframes by pktHub's NOC
# Builder, so they can't require a login session — but they do render
# internal flow/alert/device data, so every route on this router requires
# a valid X-Suite-Token (same trusted-proxy secret pktHub already sends on
# every proxied request per app/api/suite.py's docstring).
# ── Refresh interval ──────────────────────────────────────────────────────────
# pktHub's Settings → NOC → "Widget refresh" governs how often a tile reloads
# itself. It arrives as ?refresh=<seconds> on the widget URL; captured here as a
# router dependency so the ~150 view functions need no signature change.
_REFRESH: ContextVar = ContextVar("widget_refresh", default=30)


async def _capture_refresh(request: Request) -> None:
    raw = request.query_params.get("refresh")
    try:
        _REFRESH.set(max(5, min(int(raw), 3600)) if raw else 30)
    except (TypeError, ValueError):
        _REFRESH.set(30)


router   = APIRouter(dependencies=[Depends(_capture_refresh), Depends(require_suite_token)])
_s       = get_settings()
_DB      = _s.db_path

# ── Manifest ──────────────────────────────────────────────────────────────────
# `category` groups these in pktHub's NOC library picker. Every data surface the
# app renders in its own UI should have an entry here — the NOC builder can only
# offer what this list declares.
_WINDOW_PARAM = {
    "key": "minutes", "label": "Window", "type": "select",
    "options": [{"value": "60",   "label": "1 hour"},    {"value": "360",  "label": "6 hours"},
                {"value": "1440", "label": "24 hours"},  {"value": "10",   "label": "10 minutes"},
                {"value": "10080","label": "7 days"}],
}

MANIFEST = [
    # ── Overview ──────────────────────────────────────────────────────────────
    {"id":"flow_summary",      "title":"Flow Summary",       "category":"Overview",     "description":"Recent flow counts, bytes, and protocols",              "view_path":"/api/widgets/flow_summary",      "default_w":480,"default_h":300,"min_w":280,"min_h":180,
     "params":[_WINDOW_PARAM]},
    {"id":"alert_summary",     "title":"Alert Summary",      "category":"Overview",     "description":"Active alert counts by severity",                       "view_path":"/api/widgets/alert_summary",     "default_w":420,"default_h":200,"min_w":260,"min_h":150},

    # ── Traffic ───────────────────────────────────────────────────────────────
    {"id":"top_talkers",       "title":"Top Talkers",        "category":"Traffic",      "description":"Highest-volume source/destination pairs",               "view_path":"/api/widgets/top_talkers",       "default_w":640,"default_h":380,"min_w":320,"min_h":200,
     "params":[_WINDOW_PARAM]},
    {"id":"top_ports",         "title":"Top Ports",          "category":"Traffic",      "description":"Highest-traffic destination ports",                     "view_path":"/api/widgets/top_ports",         "default_w":460,"default_h":320,"min_w":260,"min_h":180,
     "params":[_WINDOW_PARAM]},
    {"id":"protocol_breakdown","title":"Protocol Breakdown", "category":"Traffic",      "description":"Traffic distribution by protocol",                      "view_path":"/api/widgets/protocol_breakdown","default_w":460,"default_h":300,"min_w":260,"min_h":180,
     "params":[_WINDOW_PARAM]},
    {"id":"recent_flows",      "title":"Recent Flows",       "category":"Traffic",      "description":"Latest flow records — source, destination, protocol",   "view_path":"/api/widgets/recent_flows",      "default_w":700,"default_h":380,"min_w":360,"min_h":220},
    {"id":"top_sources",       "title":"Top Sources",        "category":"Traffic",      "description":"Highest-volume source addresses",                       "view_path":"/api/widgets/top_sources",       "default_w":540,"default_h":340,"min_w":300,"min_h":200,
     "params":[_WINDOW_PARAM]},
    {"id":"top_destinations",  "title":"Top Destinations",   "category":"Traffic",      "description":"Highest-volume destination addresses",                  "view_path":"/api/widgets/top_destinations",  "default_w":540,"default_h":340,"min_w":300,"min_h":200,
     "params":[_WINDOW_PARAM]},
    {"id":"top_conversations", "title":"Top Conversations",  "category":"Traffic",      "description":"Busiest conversations by combined volume",              "view_path":"/api/widgets/top_conversations", "default_w":700,"default_h":360,"min_w":340,"min_h":200,
     "params":[_WINDOW_PARAM]},

    # ── Trends (charts) ───────────────────────────────────────────────────────
    {"id":"traffic_trend",     "title":"Traffic Trend",      "category":"Trends",       "description":"Throughput and flow rate over time",                    "view_path":"/api/widgets/traffic_trend",     "default_w":700,"default_h":320,"min_w":320,"min_h":180,
     "params":[_WINDOW_PARAM]},
    {"id":"protocol_trend",    "title":"Protocol Trend",     "category":"Trends",       "description":"How the protocol mix shifts over time",                 "view_path":"/api/widgets/protocol_trend",    "default_w":700,"default_h":320,"min_w":320,"min_h":180,
     "params":[_WINDOW_PARAM]},

    # ── Sites & Devices ───────────────────────────────────────────────────────
    {"id":"traffic_by_site",   "title":"Traffic by Site",    "category":"Sites & Devices","description":"Flow volume per site",                                "view_path":"/api/widgets/traffic_by_site",   "default_w":520,"default_h":320,"min_w":290,"min_h":190,
     "params":[_WINDOW_PARAM]},
    {"id":"traffic_by_sampler","title":"Traffic by Exporter","category":"Sites & Devices","description":"Flow volume per NetFlow exporter",                    "view_path":"/api/widgets/traffic_by_sampler","default_w":560,"default_h":320,"min_w":300,"min_h":190,
     "params":[_WINDOW_PARAM]},
    {"id":"collector_status",  "title":"Collector Status",   "category":"Sites & Devices","description":"NetFlow collector/exporter device health",            "view_path":"/api/widgets/collector_status",  "default_w":540,"default_h":320,"min_w":300,"min_h":200},

    # ── Maps ──────────────────────────────────────────────────────────────────
    {"id":"geo_map",           "title":"Geo Map",            "category":"Maps",         "description":"Live world map showing traffic origins & destinations", "view_path":"/api/widgets/geo_map",           "default_w":860,"default_h":500,"min_w":480,"min_h":300},
    {"id":"radar",             "title":"Radar",              "category":"Maps",         "description":"PPI scope — traffic peers by true bearing and log-compressed range",  "view_path":"/api/widgets/radar",             "default_w":520,"default_h":520,"min_w":300,"min_h":300},
    {"id":"network_topology",  "title":"Network Topology",   "category":"Maps",         "description":"Top network nodes by traffic volume",                   "view_path":"/api/widgets/network_topology",  "default_w":540,"default_h":380,"min_w":300,"min_h":220},

    # ── Alerts ────────────────────────────────────────────────────────────────
    {"id":"active_alerts",     "title":"Active Alerts",      "category":"Alerts",       "description":"Recent alert events across monitored flows",            "view_path":"/api/widgets/active_alerts",     "default_w":640,"default_h":360,"min_w":320,"min_h":200},
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
    except Exception as exc:
        _note_err(exc)
        return []


PROTO = {1:"ICMP",6:"TCP",17:"UDP",47:"GRE",50:"ESP",51:"AH",58:"ICMPv6",89:"OSPF",132:"SCTP"}
def _pname(p):
    try: return PROTO.get(int(p or 0), str(p) if p else "?")
    except Exception: return str(p) if p else "?"



# ── Widget states ──────────────────────────────────────────────────────────────
# A blank tile on a wallboard reads as "all quiet", so the three reasons a widget
# can show nothing must look different from each other:
#   empty — the query ran and there genuinely is nothing
#   cfg   — the widget needs a param chosen in the NOC editor before it can run
#   err   — the query failed; this must never be mistaken for "nothing to report"
# Query helpers record failures here rather than swallowing them; _page() renders
# the error state instead of whatever half-built body the caller produced. The
# ContextVar is per-request: each request runs in its own task context.
_WIDGET_ERR: ContextVar = ContextVar("widget_err", default=None)


def _note_err(exc: BaseException) -> None:
    _WIDGET_ERR.set(f"{type(exc).__name__}: {exc}"[:200])


def _state(kind: str, msg: str, sub: str = "") -> str:
    icon = {"empty": "○", "cfg": "⚙", "err": "⚠"}.get(kind, "○")
    sub_html = f'<div class="state-sub">{html.escape(str(sub))}</div>' if sub else ""
    return (f'<div class="state state-{kind}"><div class="state-icon">{icon}</div>'
            f'<div class="state-msg">{html.escape(str(msg))}</div>{sub_html}</div>')


def _empty(msg: str) -> str:
    return _state("empty", msg)


def _needs(msg: str) -> str:
    """The widget is fine — it is waiting on a filter the NOC editor must set."""
    return _state("cfg", msg, "Select it in the widget's Filters panel")


# ── Shared rendering helpers ──────────────────────────────────────────────────
def _page(title: str, body: str, extra_head: str = "") -> str:
    # Widget titles carry device/metric/subnet names chosen in the NOC editor
    # and read back from device data, and these pages render on an
    # unauthenticated display URL — escape before interpolating.
    title = html.escape(str(title))
    # A failed query leaves a body saying "nothing here" — which is a lie.
    _err = _WIDGET_ERR.get()
    if _err:
        body = _state("err", "Widget unavailable", _err)
    return f"""<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>{extra_head}
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:#04060a;color:#e2e8f0;font-family:'Inter',system-ui,sans-serif;font-size:13px;height:100vh;overflow:hidden;display:flex;flex-direction:column}}
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
.bar-val{{font-size:10px;color:#475569;width:70px;text-align:right;flex-shrink:0}}
.tile-row{{display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap}}
.tile{{flex:1;min-width:84px;background:#111827;border:1px solid #1e293b;border-radius:8px;padding:10px 12px}}
.tile-label{{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px}}
.tile-value{{font-size:22px;font-weight:700;color:#e2e8f0}}
.chart-wrap{{width:100%;height:100%;min-height:90px;display:flex;flex-direction:column}}
.chart-meta{{display:flex;gap:12px;font-size:10px;color:#475569;margin-bottom:6px;flex-wrap:wrap}}
.chart-meta b{{color:#94a3b8;font-weight:600}}
.chart-svg{{flex:1;width:100%;min-height:0}}
.legend{{display:flex;gap:12px;font-size:10px;color:#94a3b8;margin-top:6px;flex-wrap:wrap}}
.legend i{{width:8px;height:2px;display:inline-block;margin-right:4px;vertical-align:middle}}
.state{{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:80px;text-align:center;padding:18px;gap:5px}}
.state-icon{{font-size:17px;line-height:1;opacity:0.85}}
.state-msg{{font-size:12px;font-weight:500}}
.state-sub{{font-size:10px;color:#64748b;max-width:92%;word-break:break-word}}
.state-empty{{color:#64748b}}
.state-cfg{{color:#fbbf24}}
.state-err{{color:#f87171}}
</style>
<script>setTimeout(()=>location.reload(),{_REFRESH.get() * 1000})</script>
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
async def widget_top_talkers(minutes: int = 60):
    rows = await asyncio.to_thread(_ch, f"""
        SELECT src_ip, dst_ip, protocol, sum(bytes) as total_bytes, count() as flow_count
        FROM flows
        WHERE timestamp >= now() - INTERVAL {int(minutes)} MINUTE
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
        content = _empty("No flows received in this window")
    body = f"<div class='hdr'><div class='hdr-dot'></div><span class='hdr-title'>Top Talkers — last {_win_label(minutes)}</span></div><div class='content'>{content}</div>"
    return HTMLResponse(_page("Top Talkers", body))


# ── Flow Summary ──────────────────────────────────────────────────────────────
@router.get("/widgets/flow_summary", response_class=HTMLResponse, include_in_schema=False)
async def widget_flow_summary(minutes: int = 60):
    stats_rows = await asyncio.to_thread(_ch, f"""
        SELECT count() as total_flows, sum(bytes) as total_bytes,
               uniq(src_ip) as unique_src, uniq(dst_ip) as unique_dst
        FROM flows WHERE timestamp >= now() - INTERVAL {int(minutes)} MINUTE
    """)
    proto_rows = await asyncio.to_thread(_ch, f"""
        SELECT protocol, count() as cnt, sum(bytes) as bytes
        FROM flows WHERE timestamp >= now() - INTERVAL {int(minutes)} MINUTE
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
        table = _empty("No flows received in this window")
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
    except Exception as exc:
        _note_err(exc)
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
        content = _empty("No recent alerts")
    body = f"<div class='hdr'><div class='hdr-dot' style='background:#f87171'></div><span class='hdr-title'>Active Alerts</span></div><div class='content'>{content}</div>"
    return HTMLResponse(_page("Active Alerts", body))


# ── Top Ports ─────────────────────────────────────────────────────────────────
@router.get("/widgets/top_ports", response_class=HTMLResponse, include_in_schema=False)
async def widget_top_ports(minutes: int = 60):
    rows = await asyncio.to_thread(_ch, f"""
        SELECT dst_port, protocol, count() as flow_count, sum(bytes) as total_bytes
        FROM flows
        WHERE timestamp >= now() - INTERVAL {int(minutes)} MINUTE AND dst_port > 0
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
        content = _empty("No recent port data")
    body = f"<div class='hdr'><div class='hdr-dot' style='background:#a78bfa'></div><span class='hdr-title'>Top Ports — last 10 min</span></div><div class='content'>{content}</div>"
    return HTMLResponse(_page("Top Ports", body))


# ── Protocol Breakdown ────────────────────────────────────────────────────────
@router.get("/widgets/protocol_breakdown", response_class=HTMLResponse, include_in_schema=False)
async def widget_protocol_breakdown(minutes: int = 60):
    rows = await asyncio.to_thread(_ch, f"""
        SELECT protocol, count() as cnt, sum(bytes) as bytes
        FROM flows WHERE timestamp >= now() - INTERVAL {int(minutes)} MINUTE
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
        content = _empty("No flows received in this window")
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
    except Exception as exc:
        _note_err(exc)
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

    extra_head = f"""<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>#map{{width:100%;height:calc(100vh - 36px)}}.leaflet-container{{background:#04060a!important}}.leaflet-tooltip{{background:#111827;border:1px solid #334155;color:#e2e8f0;font-size:11px}}</style>
<script>setTimeout(()=>location.reload(),{_REFRESH.get() * 1000})</script>"""

    body = f"""<div class='hdr'><div class='hdr-dot' style='background:#2dd4bf'></div><span class='hdr-title'>Geo Map — traffic origins &amp; destinations (last 1 hr)</span></div>
<div id="map"></div>
<script>
const GD={geo_json};
const WB=L.latLngBounds([-90,-180],[90,180]);
const map=L.map('map',{{attributionControl:false,zoomControl:true,minZoom:2,
  worldCopyJump:false,maxBounds:WB,maxBoundsViscosity:1.0}});
// Esri dark canvas — CARTO's basemaps now return API-KEY-REQUIRED watermarked
// tiles. Note Esri's axis order is {{z}}/{{y}}/{{x}}, not {{z}}/{{x}}/{{y}}.
L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{{z}}/{{y}}/{{x}}',
  {{maxZoom:16,noWrap:true,bounds:WB}}).addTo(map);
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
    return HTMLResponse(f"""<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Geo Map</title>{extra_head}</head><body style="margin:0;background:#04060a;font-family:Inter,system-ui,sans-serif;display:flex;flex-direction:column;height:100vh;overflow:hidden">{body}</body></html>""")


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
        content = _empty("No flow records available")
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
        content = _empty("No topology data")
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
                    # sqlite3.Row has no .get() — index it, or convert first.
                    d = dict(row)
                    dev_names[str(d["ip"])] = f"{d['name']} ({d['site']})" if d.get("site") else str(d["name"])
    except Exception as exc:
        _note_err(exc)

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
        content = _empty("No collector data (no flows in last hour)")
    body = f"<div class='hdr'><div class='hdr-dot' style='background:#34d399'></div><span class='hdr-title'>Collector Status</span></div><div class='content'>{content}</div>"
    return HTMLResponse(_page("Collector Status", body))


# ── Shared helpers for the windowed widgets ───────────────────────────────────
def _mins(raw) -> int:
    try:
        return max(1, min(int(raw or 10), 10_080))
    except (TypeError, ValueError):
        return 10


def _win_label(minutes: int) -> str:
    if minutes >= 1440:
        return f"{minutes // 1440}d"
    if minutes >= 60:
        return f"{minutes // 60} hr"
    return f"{minutes} min"


def _shell(title: str, content: str, dot: str = "#60a5fa") -> str:
    return (f"<div class='hdr'><div class='hdr-dot' style='background:{dot}'></div>"
            f"<span class='hdr-title'>{html.escape(title)}</span></div>"
            f"<div class='content'>{content}</div>")


def _tiles(pairs) -> str:
    return "<div class='tile-row'>" + "".join(
        f"<div class='tile'><div class='tile-label'>{html.escape(str(label))}</div>"
        f"<div class='tile-value'>{html.escape(str(value))}</div></div>"
        for label, value in pairs
    ) + "</div>"


def _bars(rows, color: str = "#60a5fa") -> str:
    """rows = [(label, numeric_value, display_value)] — scaled to the largest."""
    peak = max((r[1] or 0) for r in rows) if rows else 0
    return "".join(
        f"<div class='bar-row'><div class='bar-lbl' title='{html.escape(str(lbl))}'>{html.escape(str(lbl))}</div>"
        f"<div class='bar-trk'><div class='bar-fill' style='width:{(val / peak * 100) if peak else 0:.1f}%;background:{color}'></div></div>"
        f"<div class='bar-val'>{html.escape(str(disp))}</div></div>"
        for lbl, val, disp in rows
    )


_SERIES_COLORS = ("#60a5fa", "#4ade80", "#fbbf24", "#f87171", "#a78bfa")


def _line_chart(series, fmt=_fmt_n, height: int = 120) -> str:
    """series = [(label, [float, ...])] — equal-length samples, oldest first.

    Server-rendered inline SVG so the iframe stays dependency-free: pktFlow ships
    no charting library to these views, and the NOC display must render without
    network access to anything but this app."""
    series = [(lbl, [v for v in vals if v is not None]) for lbl, vals in series]
    series = [(lbl, vals) for lbl, vals in series if len(vals) >= 2]
    if not series:
        return _empty("No flow data in window")

    W, H, PAD = 600, height, 4
    lo = min(min(v) for _, v in series)
    hi = max(max(v) for _, v in series)
    span = (hi - lo) or 1.0

    def _y(v: float) -> float:
        return PAD + (H - 2 * PAD) * (1 - (v - lo) / span)

    paths, legend = [], []
    for i, (lbl, vals) in enumerate(series):
        color = _SERIES_COLORS[i % len(_SERIES_COLORS)]
        step  = W / (len(vals) - 1)
        pts   = [(j * step, _y(v)) for j, v in enumerate(vals)]
        line  = "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts)
        area  = f"{line} L{W:.1f},{H} L0,{H} Z"
        paths.append(
            f'<path d="{area}" fill="{color}" opacity="0.10"/>'
            f'<path d="{line}" fill="none" stroke="{color}" stroke-width="1.5" '
            f'stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>'
        )
        legend.append(f"<span><i style='background:{color}'></i>{html.escape(str(lbl))} "
                      f"<b>{html.escape(fmt(vals[-1]))}</b></span>")

    meta = (f"<div class='chart-meta'><span>min <b>{html.escape(fmt(lo))}</b></span>"
            f"<span>peak <b>{html.escape(fmt(hi))}</b></span>"
            f"<span>samples <b>{max(len(v) for _, v in series)}</b></span></div>")
    return (f"<div class='chart-wrap'>{meta}"
            f'<svg class="chart-svg" viewBox="0 0 {W} {H}" preserveAspectRatio="none" '
            f'xmlns="http://www.w3.org/2000/svg">{"".join(paths)}</svg>'
            f"<div class='legend'>{''.join(legend)}</div></div>")


# ── Alert Summary ─────────────────────────────────────────────────────────────
@router.get("/widgets/alert_summary", response_class=HTMLResponse, include_in_schema=False)
async def widget_alert_summary():
    counts = {}
    try:
        async with aiosqlite.connect(_DB) as db:
            async with db.execute(
                "SELECT LOWER(severity), COUNT(*) FROM alert_events "
                "WHERE resolved_at IS NULL GROUP BY 1"
            ) as cur:
                counts = {str(s): n for s, n in await cur.fetchall()}
    except Exception as exc:
        _note_err(exc)

    content = _tiles([
        ("Active",   sum(counts.values())),
        ("Critical", counts.get("critical", 0)),
        ("Warning",  counts.get("warning", 0)),
        ("Info",     counts.get("info", 0)),
    ])
    return HTMLResponse(_page("Alert Summary", _shell("Alert Summary", content)))


# ── Top Sources / Destinations ────────────────────────────────────────────────
async def _top_endpoint(column: str, minutes: int) -> list:
    # `column` is chosen by the caller from a literal, never from request input.
    return await asyncio.to_thread(_ch, f"""
        SELECT {column}, sum(bytes) as total_bytes, count() as flow_count
        FROM flows
        WHERE timestamp >= now() - INTERVAL {int(minutes)} MINUTE
        GROUP BY {column}
        ORDER BY total_bytes DESC
        LIMIT 25
    """)


@router.get("/widgets/top_sources", response_class=HTMLResponse, include_in_schema=False)
async def widget_top_sources(minutes: int = 60):
    minutes = _mins(minutes)
    rows    = await _top_endpoint("src_ip", minutes)
    content = _bars([(str(r[0]), r[1] or 0, _fmt_bytes(r[1] or 0)) for r in rows]) \
        if rows else _empty("No flows received in this window")
    return HTMLResponse(_page("Top Sources", _shell(f"Top Sources — last {_win_label(minutes)}", content)))


@router.get("/widgets/top_destinations", response_class=HTMLResponse, include_in_schema=False)
async def widget_top_destinations(minutes: int = 60):
    minutes = _mins(minutes)
    rows    = await _top_endpoint("dst_ip", minutes)
    content = _bars([(str(r[0]), r[1] or 0, _fmt_bytes(r[1] or 0)) for r in rows], color="#4ade80") \
        if rows else _empty("No flows received in this window")
    return HTMLResponse(_page("Top Destinations", _shell(f"Top Destinations — last {_win_label(minutes)}", content)))


# ── Top Conversations ─────────────────────────────────────────────────────────
@router.get("/widgets/top_conversations", response_class=HTMLResponse, include_in_schema=False)
async def widget_top_conversations(minutes: int = 60):
    minutes = _mins(minutes)
    rows = await asyncio.to_thread(_ch, f"""
        SELECT src_ip, dst_ip, dst_port, protocol,
               sum(bytes) as total_bytes, sum(packets) as total_packets, count() as flow_count
        FROM flows
        WHERE timestamp >= now() - INTERVAL {int(minutes)} MINUTE
        GROUP BY src_ip, dst_ip, dst_port, protocol
        ORDER BY total_bytes DESC
        LIMIT 25
    """)
    if rows:
        trs = "".join(
            f"<tr><td>{html.escape(str(r[0]))}</td><td>{html.escape(str(r[1]))}</td>"
            f"<td>{r[2]}</td><td><span class='badge bl'>{html.escape(_pname(r[3]))}</span></td>"
            f"<td>{_fmt_bytes(r[4] or 0)}</td><td>{_fmt_n(r[5] or 0)}</td></tr>"
            for r in rows
        )
        content = ("<table><thead><tr><th>Source</th><th>Destination</th><th>Port</th>"
                   "<th>Proto</th><th>Bytes</th><th>Packets</th></tr></thead>"
                   f"<tbody>{trs}</tbody></table>")
    else:
        content = _empty("No flows received in this window")
    return HTMLResponse(_page("Top Conversations",
                              _shell(f"Top Conversations — last {_win_label(minutes)}", content)))


# ── Traffic Trend (chart) ─────────────────────────────────────────────────────
@router.get("/widgets/traffic_trend", response_class=HTMLResponse, include_in_schema=False)
async def widget_traffic_trend(minutes: int = 60):
    minutes = _mins(minutes)
    # Aim for roughly 60 points regardless of window, so the shape stays readable.
    bucket  = max(1, minutes // 60)
    rows = await asyncio.to_thread(_ch, f"""
        SELECT toStartOfInterval(timestamp, INTERVAL {bucket} MINUTE) as b,
               sum(bytes) as total_bytes, count() as flow_count
        FROM flows
        WHERE timestamp >= now() - INTERVAL {int(minutes)} MINUTE
        GROUP BY b ORDER BY b ASC
    """)
    if rows:
        # Bytes and flow counts differ by orders of magnitude, so they get their
        # own vertical scale rather than one series flattening the other. Each
        # chart fills half the tile — .chart-wrap is height:100%, so they need a
        # flex parent or the second one overflows.
        content = (
            "<div style='display:flex;flex-direction:column;gap:10px;height:100%'>"
            f"<div style='flex:1;min-height:0'>{_line_chart([('Bytes', [r[1] for r in rows])], fmt=_fmt_bytes)}</div>"
            f"<div style='flex:1;min-height:0'>{_line_chart([('Flows', [r[2] for r in rows])])}</div>"
            "</div>"
        )
    else:
        content = _empty("No flow data in window")
    return HTMLResponse(_page("Traffic Trend",
                              _shell(f"Traffic — last {_win_label(minutes)}", content)))


# ── Protocol Trend (chart) ────────────────────────────────────────────────────
@router.get("/widgets/protocol_trend", response_class=HTMLResponse, include_in_schema=False)
async def widget_protocol_trend(minutes: int = 60):
    minutes = _mins(minutes)
    bucket  = max(1, minutes // 60)
    rows = await asyncio.to_thread(_ch, f"""
        SELECT toStartOfInterval(timestamp, INTERVAL {bucket} MINUTE) as b,
               protocol, sum(bytes) as total_bytes
        FROM flows
        WHERE timestamp >= now() - INTERVAL {int(minutes)} MINUTE
        GROUP BY b, protocol ORDER BY b ASC
    """)
    # Pivot to one series per protocol, over the shared ordered bucket axis.
    buckets, series = [], {}
    for b, proto, total in rows:
        if b not in buckets:
            buckets.append(b)
        series.setdefault(_pname(proto), {})[b] = total

    ranked = sorted(series.items(), key=lambda kv: -sum(kv[1].values()))[:4]
    content = _line_chart(
        [(name, [vals.get(b, 0) for b in buckets]) for name, vals in ranked], fmt=_fmt_bytes
    ) if buckets else _empty("No flow data in window")
    return HTMLResponse(_page("Protocol Trend",
                              _shell(f"Protocol Mix — last {_win_label(minutes)}", content)))


# ── Traffic by Site / Exporter ────────────────────────────────────────────────
async def _traffic_grouped(column: str, minutes: int) -> list:
    # `column` is chosen by the caller from a literal, never from request input.
    return await asyncio.to_thread(_ch, f"""
        SELECT {column}, sum(bytes) as total_bytes, count() as flow_count
        FROM flows
        WHERE timestamp >= now() - INTERVAL {int(minutes)} MINUTE
        GROUP BY {column}
        ORDER BY total_bytes DESC
        LIMIT 25
    """)


@router.get("/widgets/traffic_by_site", response_class=HTMLResponse, include_in_schema=False)
async def widget_traffic_by_site(minutes: int = 60):
    minutes = _mins(minutes)
    rows    = await _traffic_grouped("site", minutes)
    content = _bars([
        (str(r[0]) or "Unassigned", r[1] or 0, _fmt_bytes(r[1] or 0)) for r in rows
    ], color="#fbbf24") if rows else _empty("No flow data in window")
    return HTMLResponse(_page("Traffic by Site",
                              _shell(f"Traffic by Site — last {_win_label(minutes)}", content)))


@router.get("/widgets/traffic_by_sampler", response_class=HTMLResponse, include_in_schema=False)
async def widget_traffic_by_sampler(minutes: int = 60):
    minutes = _mins(minutes)
    rows    = await _traffic_grouped("sampler_ip", minutes)

    names = {}
    try:
        async with aiosqlite.connect(_DB) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("SELECT ip, name FROM devices") as cur:
                names = {r["ip"]: r["name"] for r in await cur.fetchall()}
    except Exception as exc:
        _note_err(exc)

    content = _bars([
        (names.get(str(r[0]), str(r[0])), r[1] or 0, _fmt_bytes(r[1] or 0)) for r in rows
    ], color="#34d399") if rows else _empty("No flow data in window")
    return HTMLResponse(_page("Traffic by Exporter",
                              _shell(f"Traffic by Exporter — last {_win_label(minutes)}", content)))


# ── Radar (PPI scope) ─────────────────────────────────────────────────────────
# The same /flows/geo payload the Geo Map plots, read as a plan-position
# indicator: every peer at its true initial bearing from the centroid of the
# mapped locations, at a log-compressed great-circle range so a 300 km hop and a
# 17 000 km hop both stay readable on one face. Rendered as server-side SVG —
# unlike geo_map this pulls no tile layer or CDN script, so it keeps working on a
# wallboard with no outbound internet.
def _hav_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r1, r2 = math.radians(lat1), math.radians(lat2)
    dlat   = r2 - r1
    dlng   = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(r1) * math.cos(r2) * math.sin(dlng / 2) ** 2
    return 6371.0 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _bearing_deg(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r1, r2 = math.radians(lat1), math.radians(lat2)
    dlng   = math.radians(lng2 - lng1)
    y = math.sin(dlng) * math.cos(r2)
    x = math.cos(r1) * math.sin(r2) - math.sin(r1) * math.cos(r2) * math.cos(dlng)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def _spherical_centroid(pts: list) -> tuple:
    """Mean direction on the sphere — a plain lat/lng average is wrong across
    the antimeridian, which is exactly where a peer set tends to straddle."""
    x = y = z = 0.0
    for lat, lng in pts:
        rlat, rlng = math.radians(lat), math.radians(lng)
        x += math.cos(rlat) * math.cos(rlng)
        y += math.cos(rlat) * math.sin(rlng)
        z += math.sin(rlat)
    n = len(pts) or 1
    x, y, z = x / n, y / n, z / n
    hyp = math.sqrt(x * x + y * y)
    if hyp < 1e-9 and abs(z) < 1e-9:
        return 0.0, 0.0
    return math.degrees(math.atan2(z, hyp)), math.degrees(math.atan2(y, x))


@router.get("/widgets/radar", response_class=HTMLResponse, include_in_schema=False)
async def widget_radar():
    rows = await asyncio.to_thread(_ch, """
        SELECT src_ip, dst_ip, sum(bytes) as bytes
        FROM flows WHERE timestamp >= now() - INTERVAL 1 HOUR
        GROUP BY src_ip, dst_ip ORDER BY bytes DESC LIMIT 60
    """)
    pairs   = [{"src_ip": str(r[0]), "dst_ip": str(r[1]), "bytes": r[2] or 0} for r in rows]
    all_ips = list({ip for p in pairs for ip in (p["src_ip"], p["dst_ip"]) if not _is_private(ip)})
    geo     = await asyncio.to_thread(_fetch_geo, all_ips)

    ip_bytes: dict = {}
    for p in pairs:
        for f in ("src_ip", "dst_ip"):
            if p[f] in geo:
                ip_bytes[p[f]] = ip_bytes.get(p[f], 0) + p["bytes"]

    peers = [
        {"ip": ip, "lat": g["lat"], "lng": g["lng"],
         "city": g.get("city", ""), "country": g.get("country", ""),
         "bytes": ip_bytes.get(ip, 0)}
        for ip, g in geo.items()
    ]
    if not peers:
        body = ("<div class='hdr'><div class='hdr-dot' style='background:#4ade80'></div>"
                "<span class='hdr-title'>Radar</span></div>"
                f"<div class='content'>{_empty('No public IP geo data available')}</div>")
        return HTMLResponse(_page("Radar", body))

    olat, olng = _spherical_centroid([(p["lat"], p["lng"]) for p in peers])
    for p in peers:
        p["km"]  = _hav_km(olat, olng, p["lat"], p["lng"])
        p["brg"] = _bearing_deg(olat, olng, p["lat"], p["lng"])

    max_km   = max((p["km"] for p in peers), default=1.0) or 1.0
    max_byte = max((p["bytes"] for p in peers), default=1) or 1
    C, R     = 200.0, 178.0

    def _rr(km: float) -> float:
        # Log compression, so near and far peers share one readable face.
        return R * (math.log10(1 + km) / math.log10(1 + max_km)) if max_km > 0 else 0.0

    rings = "".join(
        f'<circle cx="{C}" cy="{C}" r="{R * f:.1f}" fill="none" stroke="#1e293b" stroke-width="1"/>'
        f'<text x="{C + 3}" y="{C - R * f + 11:.1f}" fill="#334155" font-size="9">'
        f'{int(round((10 ** (f * math.log10(1 + max_km)) - 1))):,} km</text>'
        for f in (0.25, 0.5, 0.75, 1.0)
    )
    spokes = "".join(
        f'<line x1="{C}" y1="{C}" x2="{C + R * math.sin(math.radians(d)):.1f}" '
        f'y2="{C - R * math.cos(math.radians(d)):.1f}" stroke="#1e293b" stroke-width="1"/>'
        for d in (0, 45, 90, 135, 180, 225, 270, 315)
    )
    cardinals = "".join(
        f'<text x="{C + (R + 12) * math.sin(math.radians(d)):.1f}" '
        f'y="{C - (R + 12) * math.cos(math.radians(d)) + 4:.1f}" fill="#475569" '
        f'font-size="10" text-anchor="middle">{lbl}</text>'
        for d, lbl in ((0, "N"), (90, "E"), (180, "S"), (270, "W"))
    )

    blips = []
    for p in sorted(peers, key=lambda q: -q["bytes"]):
        rad = _rr(p["km"])
        x   = C + rad * math.sin(math.radians(p["brg"]))
        y   = C - rad * math.cos(math.radians(p["brg"]))
        sz  = max(2.5, min(11.0, math.sqrt(p["bytes"] / max_byte) * 11.0))
        loc = ", ".join(v for v in (p["city"], p["country"]) if v)
        tip = f'{p["ip"]}{chr(10) + loc if loc else ""}{chr(10)}{_fmt_bytes(p["bytes"])} · {int(round(p["km"])):,} km'
        blips.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{sz:.1f}" fill="#4ade80" fill-opacity="0.28" '
            f'stroke="#4ade80" stroke-width="1.2"><title>{html.escape(tip)}</title></circle>'
        )

    body = (
        "<div class='hdr'><div class='hdr-dot' style='background:#4ade80'></div>"
        "<span class='hdr-title'>Radar — peers by bearing &amp; range (last 1 hr)</span></div>"
        "<div class='content' style='display:flex;align-items:center;justify-content:center'>"
        f'<svg viewBox="0 0 400 400" style="width:100%;height:100%;max-height:100%" '
        f'xmlns="http://www.w3.org/2000/svg">{rings}{spokes}{cardinals}'
        f'<circle cx="{C}" cy="{C}" r="3" fill="#60a5fa"><title>Your network (centroid)</title></circle>'
        f'{"".join(blips)}</svg></div>'
    )
    return HTMLResponse(_page("Radar", body))
