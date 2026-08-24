"""
app/api/resonance_data.py — the data half of the resonance contract.

app/api/resonance.py mounts the panel. This module is what the panel is
allowed to *read* once it is mounted, and it exists because the embed contract
has three parts and mounting only satisfies one of them:

  1. an OpenAPI document at a stable same-origin path      -> /api/resonance/openapi.json
  2. a grant file naming what may be called                -> /.well-known/resonance.json
  3. endpoints that behave: bounded, JSON, stable fields   -> /api/resonance/data/*

Why a separate surface rather than granting against /api/flows/* directly.
The operations named in a grant have to carry a stable operationId, prose a
stranger can choose between, enums for every fixed vocabulary, a declared
response schema, and a bounded page with a total. pktFlow's own flow search
returns a bare array of up to five thousand records with no total at all —
which is the right answer for the Flow Explorer and completely wrong for a
conversation. Retrofitting the contract onto it would change a response shape
the frontend already consumes. These wrap the same storage calls instead, so
there is no second implementation of any query — only a second, narrower
doorway with the labels the model needs and a page a person can actually be
read back to.

Authentication is the app's existing session, not a new one. The panel's calls
are ordinary same-origin fetches from our own page, so they carry the refresh
cookie exactly as /api/resonance/code does, and they are admitted by the same
helpers that admit /code — see resonance_session_user below. Nothing here
issues, accepts or understands a credential of resonance's, and the panel can
therefore only ever read what the signed-in person could already read.

WHAT IS DELIBERATELY ABSENT IS PART OF THE DESIGN. Nothing here purges a
sampler's history, edits a site, a NAT mapping or a traffic rule, or changes
retention. The two operations that change state acknowledge an alert; the third
switches an existing rule.

FLOW SEARCH IS CAPPED HARDER THAN ANYTHING ELSE IN THIS SUITE. A flow record is
wide and an unbounded window over a busy exporter is millions of them, so the
page here is small, the caller must give a window, and the true count comes
back alongside so the assistant can say "eleven thousand matched, here are
twenty-five" rather than pretending the page is the answer.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
from dataclasses import dataclass
from typing import Any, Literal, Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.exceptions import ResponseValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app.database import get_db

# Deliberately the same helpers /api/resonance/code uses, imported rather than
# reimplemented: the two surfaces must never disagree about who counts as
# signed in, which origin counts as ours, or whether the feature is on.
from app.api.resonance import (
    LEVEL_RANK, _allowed_roles, _get, _same_origin, _user_for_code, role_level,
)
from app.dependencies import require_admin, require_analyst

log = logging.getLogger("pktflow.api.resonance_data")

router = APIRouter(tags=["resonance-data"])

DATA_PREFIX = "/api/resonance/data"
SPEC_PATH = "/api/resonance/openapi.json"
GRANT_PATH = "/.well-known/resonance.json"


# ── What the assistant is allowed to call ────────────────────────────────────
#
# The one list. The grant file is generated from it, the published spec is
# filtered to it, and startup checks it against the routes that actually exist.
# An operationId that is not here is invisible to the assistant even though it
# is a perfectly ordinary route of this app.


@dataclass(frozen=True)
class Grant:
    op: str
    # Set on ANY operation that changes state, whatever its HTTP verb.
    # Resonance reads the values back to the person before running one.
    writes: bool = False


GRANTED: tuple[Grant, ...] = (
    Grant("getFlowSummary"),
    Grant("listFlowSources"),
    Grant("searchFlows"),
    Grant("getTopTalkers"),
    Grant("listSites"),
    Grant("listAlertEvents"),
    Grant("listAlertRules"),
    Grant("searchApplicationLog"),
    # Everything below changes state. Deliberately no purge of a sampler's
    # history, no retention change, and no create, edit or delete of a site,
    # NAT mapping or traffic rule.
    Grant("ackAlertEvent", writes=True),
    Grant("ackAllAlertEvents", writes=True),
    Grant("toggleAlertRule", writes=True),
)


# ── Vocabulary ────────────────────────────────────────────────────────────────
#
# These are the enums the requirement is really about: without them a model asks
# for a window of "last hour" or a protocol of "tcp", gets a 422, and reports
# the app as broken. The window shorthand is pktFlow's own; the protocol is an
# IANA number because that is what a flow record carries — 6 is TCP, 17 is UDP,
# 1 is ICMP — and the summary spells that out so a model does not have to guess.

TimeWindow = Literal["1h", "6h", "24h", "7d", "30d"]
AlertSeverity = Literal["info", "warning", "critical"]
LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]


# ── Errors ────────────────────────────────────────────────────────────────────


class ResonanceDataError(HTTPException):
    """Rendered as {"error": "..."} — the message reaches the person verbatim."""


class ErrorResponse(BaseModel):
    error: str = Field(description="What went wrong, phrased for the person to act on.")


def register_error_handler(app) -> None:
    """Give this surface the {"error": ...} body the grant contract specifies.

    Scoped to ResonanceDataError so the rest of the app keeps FastAPI's
    {"detail": ...}, which its own frontend already reads.
    """

    @app.exception_handler(ResonanceDataError)
    async def _render(_request: Request, exc: ResonanceDataError):  # noqa: ANN202
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

    @app.exception_handler(ResponseValidationError)
    async def _schema_drifted(request: Request, exc: ResponseValidationError):  # noqa: ANN202
        """Report a declared schema that no longer matches what the tables return.

        This fires after the route body has already succeeded, so the module's
        own try/except cannot see it, and it is logged by uvicorn rather than by
        anything the SQLite handler is attached to — a 500 with a generic
        message in the panel and not one line anywhere on the server. Now it
        names the fields.

        Only this surface is rewritten; every other response_model in the app
        keeps FastAPI's existing behaviour.
        """
        if not request.url.path.startswith("/api/resonance/"):
            raise exc
        fields = sorted({".".join(str(p) for p in err.get("loc", ())[-2:])
                         for err in exc.errors()})[:8]
        log.error(
            "resonance response schema no longer matches the data on %s: %s",
            request.url.path, ", ".join(fields) or "unknown field",
        )
        return JSONResponse(
            {"error": "pktFlow produced a result it could not describe. This is a fault in "
                      "pktFlow, not in the question — it has been logged."},
            status_code=500,
        )


_ERRORS: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorResponse, "description": "No signed-in session on this request."},
    403: {"model": ErrorResponse, "description": "Signed in, but not permitted to use the assistant."},
    404: {"model": ErrorResponse, "description": "The assistant is switched off on this install."},
    503: {"model": ErrorResponse, "description": "A backing store this operation needs is not available."},
    504: {"model": ErrorResponse, "description": "The store did not answer in time; ask something narrower."},
}


# ── Session ───────────────────────────────────────────────────────────────────


async def resonance_session_user(
    request: Request, db: aiosqlite.Connection = Depends(get_db)
) -> dict:
    """Admit a call the panel made from our own page, on this app's own session.

    Same four gates as /api/resonance/code, in the same order and for the same
    reasons: the request must present as same-origin before any cookie is
    honoured, it must carry a session we recognise, the feature must be on, and
    the person's role must be one an admin listed. The last two mean this whole
    surface is inert on an install that never enabled the panel — a route that
    exists but answers 404 until someone turns the feature on deliberately.
    """
    if not _same_origin(request):
        raise ResonanceDataError(status_code=403, detail="Cross-site request refused.")

    user = await _user_for_code(request, db)
    if not user:
        raise ResonanceDataError(status_code=401, detail="Not signed in to pktFlow.")

    if not bool(await _get(db, "resonance_enabled", False)):
        raise ResonanceDataError(status_code=404, detail="The assistant is not enabled on this install.")

    if user["role"] not in await _allowed_roles(db):
        raise ResonanceDataError(
            status_code=403, detail="Your role is not permitted to use the assistant."
        )

    # Audit trail, and the only way to answer "did the assistant actually ask us
    # anything". A successful read is otherwise silent, so without this the
    # difference between "the panel never called" and "the panel called and got
    # what it wanted" is invisible from the server — which is exactly the
    # question asked when an answer looks wrong. One line per call, at INFO, so
    # it lands in the Logs page too.
    route = request.scope.get("route")
    log.info(
        "resonance call: %s (%s) -> %s",
        user.get("username"), user.get("role"),
        getattr(route, "operation_id", None) or request.url.path,
    )
    return user


async def resonance_write_user(
    request: Request, db: aiosqlite.Connection = Depends(get_db)
) -> dict:
    """As above, and the role must be set to "write" rather than "read".

    Two gates have to agree before anything changes, and they answer different
    questions. This one is the admin's: has this role been trusted to let the
    assistant act at all. The second, inside each operation, is pktFlow's own:
    may this person do this thing anyway. A role set to "write" never gains a
    right its holder does not already have in the interface — it only decides
    whether the assistant may exercise the rights they do have.
    """
    user = await resonance_session_user(request, db)
    if LEVEL_RANK.get(await role_level(db, user["role"]), 0) < LEVEL_RANK["write"]:
        raise ResonanceDataError(
            status_code=403,
            detail=("The assistant is set to read-only for your role, so it cannot make "
                    "that change. An administrator sets this under Settings → Resonance."),
        )
    return user


async def _apply_app_rule(user: dict, rule, what: str) -> None:
    """Apply pktFlow's own role rule for the endpoint this operation mirrors.

    The rule itself is imported rather than restated, so a change to who may do
    something in the interface reaches the assistant in the same commit instead
    of leaving two role models to drift apart.
    """
    try:
        await rule(user)
    except HTTPException as exc:
        raise ResonanceDataError(
            status_code=exc.status_code,
            detail=f"Your pktFlow role does not permit you to {what}.",
        ) from exc


SessionUser = Depends(resonance_session_user)
WriteUser = Depends(resonance_write_user)


class Flow(BaseModel):
    """One flow record, as an exporter reported it."""

    model_config = ConfigDict(extra="allow")

    timestamp: Optional[str] = Field(None, description="When the flow was recorded (ISO 8601).")
    sampler_ip: Optional[str] = Field(None, description="The exporter that reported it.")
    sampler_name: Optional[str] = None
    src_ip: Optional[str] = None
    dst_ip: Optional[str] = None
    src_port: Optional[int] = None
    dst_port: Optional[int] = None
    protocol: Optional[int] = Field(None, description="IANA protocol number — 6 TCP, 17 UDP, 1 ICMP.")
    bytes: Optional[int] = None
    packets: Optional[int] = None
    duration_ms: Optional[int] = None


class FlowSearchResultList(BaseModel):
    model_config = ConfigDict(extra="allow")
    total: int = Field(description="How many flows matched the filters and window, before paging.")
    limit: int
    offset: int
    returned: int = 0
    truncated_for_size: bool = Field(
        False, description="True when the page was cut to fit. Ask for fewer, or narrow the window."
    )
    window_start: Optional[str] = Field(None, description="Start of the window searched (ISO 8601).")
    window_end: Optional[str] = Field(None, description="End of the window searched (ISO 8601).")
    flows: list[Flow] = Field(default_factory=list)


class TopTalker(BaseModel):
    """One source/destination pair, ranked by volume."""

    model_config = ConfigDict(extra="allow")

    src_ip: Optional[str] = None
    dst_ip: Optional[str] = None
    dst_port: Optional[int] = None
    protocol: Optional[int] = Field(None, description="IANA protocol number — 6 TCP, 17 UDP, 1 ICMP.")
    bytes: Optional[int] = None
    megabytes: Optional[float] = Field(None, description="The same volume in MB, for reading aloud.")
    packets: Optional[int] = None
    flow_count: Optional[int] = None


class TopTalkerList(BaseModel):
    model_config = ConfigDict(extra="allow")
    total: int
    returned: int = 0
    truncated_for_size: bool = False
    window_start: Optional[str] = None
    window_end: Optional[str] = None
    talkers: list[TopTalker] = Field(default_factory=list)


class FlowSource(BaseModel):
    """One exporter sending flow records here."""

    model_config = ConfigDict(extra="allow")

    sampler_ip: Optional[str] = None
    sampler_name: Optional[str] = None
    site: Optional[str] = None
    bytes_last_hour: Optional[int] = None
    packets_last_hour: Optional[int] = None
    flows_last_hour: Optional[int] = None
    flows_per_sec: Optional[float] = None
    last_seen: Optional[str] = Field(None, description="When it last sent anything (ISO 8601).")


class FlowSourceList(BaseModel):
    model_config = ConfigDict(extra="allow")
    total: int
    returned: int = 0
    truncated_for_size: bool = False
    sources: list[FlowSource] = Field(default_factory=list)


class Site(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: int
    name: Optional[str] = None
    display_name: Optional[str] = None
    ip_cidr: Optional[str] = Field(None, description="The address range this site covers.")


class SiteList(BaseModel):
    model_config = ConfigDict(extra="allow")
    total: int
    returned: int = 0
    truncated_for_size: bool = False
    sites: list[Site] = Field(default_factory=list)


class FlowSummary(BaseModel):
    """The state of collection — the "is anything even arriving" answer."""

    model_config = ConfigDict(extra="allow")

    flows_per_sec: Optional[float] = Field(None, description="Sustained ingest rate over the last minute.")
    sources: int = Field(description="Exporters that have ever sent anything.")
    sources_active_last_hour: int = Field(description="Of those, ones that sent in the last hour.")
    bytes_last_hour: int = Field(description="Total volume across every exporter in the last hour.")
    flows_last_hour: int
    sites: int
    unacknowledged_alerts: int


class AlertEvent(BaseModel):
    """One firing of a pktFlow alert rule."""

    model_config = ConfigDict(extra="allow")

    id: int
    rule_id: Optional[int] = None
    rule_name: Optional[str] = Field(None, description="Name of the rule that fired.")
    severity: Optional[str] = None
    message: Optional[str] = None
    fired_at: Optional[str] = Field(None, description="When it fired (ISO 8601).")
    acked_at: Optional[str] = Field(None, description="When it was acknowledged, or null if nobody has.")
    resolved_at: Optional[str] = Field(None, description="When the condition cleared, or null if it has not.")
    auto_resolved: Optional[int] = Field(None, description="1 when it cleared on its own.")


class AlertEventList(BaseModel):
    model_config = ConfigDict(extra="allow")
    total: int
    limit: int
    offset: int
    returned: int = 0
    truncated_for_size: bool = False
    events: list[AlertEvent] = Field(default_factory=list)


class AlertRule(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: int
    name: Optional[str] = None
    description: Optional[str] = None
    rule_type: Optional[str] = Field(None, description="What the rule watches.")
    severity: Optional[str] = None
    enabled: bool = False
    time_window_min: Optional[int] = None
    cooldown_min: Optional[int] = None
    last_fired: Optional[str] = None
    created_at: Optional[str] = None


class AlertRuleList(BaseModel):
    model_config = ConfigDict(extra="allow")
    total: int
    returned: int = 0
    truncated_for_size: bool = False
    rules: list[AlertRule] = Field(default_factory=list)


class AppLogRecord(BaseModel):
    """One line of pktFlow's own diagnostic log — not flow data."""

    model_config = ConfigDict(extra="allow")

    id: int
    level: Optional[str] = None
    logger: Optional[str] = Field(None, description="Which part of pktFlow wrote it.")
    message: Optional[str] = None
    created_at: Optional[str] = Field(None, description="When it was written (ISO 8601).")


class AppLogResult(BaseModel):
    model_config = ConfigDict(extra="allow")
    total: int
    limit: int
    offset: int
    returned: int = 0
    truncated_for_size: bool = False
    records: list[AppLogRecord] = Field(default_factory=list)


# ── Operations ────────────────────────────────────────────────────────────────
#
# Every summary and description here is written for a reader who has never seen
# pktFlow, because that is literally what chooses between them: a model picks an
# operation from these sentences and nothing else. "Search logs" would leave it
# guessing between the certificate inventory and the app's own diagnostics,
# which are two entirely different questions asked with almost the same words.

# One page is capped well below what the SPA allows. The panel's results are
# read back to a person in a conversation, so a hundred rows is already past the
# point of being an answer, and a model handed five hundred narrows nothing. The
# maxima are deliberately above what always fits — _fit() reports the cut, and a
# caller that wants density should be able to ask for it.
_SEARCH_DEFAULT, _SEARCH_MAX = 25, 100
_LIST_DEFAULT, _LIST_MAX = 50, 200

# Resonance truncates a result over 20 KB and tells the model it did. That turns
# a clean page into JSON that stops mid-record, so the cut is made here instead,
# where it can leave the envelope intact and say what happened in a field the
# model can act on. 18 KB leaves headroom for transport framing.
_RESULT_BUDGET_BYTES = 18_000

# Resonance gives up on a call after 20 seconds and tells the person the
# application did not answer. Answering at 15 with something they can act on
# beats going quiet at 20.
_CALL_TIMEOUT_SECONDS = 15


def _encoded_size(value: Any) -> int:
    return len(json.dumps(value, default=str).encode("utf-8"))


def _fit(payload: dict, items_key: str) -> dict:
    """Trim a page to the byte budget, and record that it had to.

    Always keeps at least one item: an empty page for one oversized record is a
    worse answer than an oversized one, and the caller can still see `total`.
    """
    items = list(payload.get(items_key) or [])
    # Price the envelope with the two fields this adds, so adding them cannot
    # push a result that just fitted back over the line.
    envelope = dict(payload)
    envelope[items_key] = []
    envelope["returned"] = len(items)
    envelope["truncated_for_size"] = True
    budget = _RESULT_BUDGET_BYTES - _encoded_size(envelope)

    kept: list = []
    used = 0
    for item in items:
        size = _encoded_size(item) + 1   # + the separating comma
        if kept and used + size > budget:
            break
        kept.append(item)
        used += size

    payload[items_key] = kept
    payload["returned"] = len(kept)
    payload["truncated_for_size"] = len(kept) < len(items)
    return payload


async def _in_time(awaitable, what: str):
    """Bound a query so a slow one is answered rather than abandoned."""
    try:
        return await asyncio.wait_for(awaitable, _CALL_TIMEOUT_SECONDS)
    except asyncio.TimeoutError as exc:
        raise ResonanceDataError(
            status_code=504,
            detail=(
                f"pktFlow took longer than {_CALL_TIMEOUT_SECONDS} seconds to {what}. "
                "Narrow the time range, or filter by status, CA or name."
            ),
        ) from exc

# A flow record is far wider than a log line, and an hour of a busy exporter is
# millions of them. These are deliberately below the app's own Flow Explorer
# caps: the Explorer paints a table, this gets read back to a person.
_FLOW_DEFAULT, _FLOW_MAX = 25, 100

_WINDOWS = {"1h": 1, "6h": 6, "24h": 24, "7d": 168, "30d": 720}


def _window_bounds(window: str):
    """(start, end) for one of the shorthand windows. Mirrors app/api/flows.py."""
    from datetime import datetime, timedelta, timezone

    end = datetime.now(tz=timezone.utc)
    return end - timedelta(hours=_WINDOWS.get(window, 1)), end


def _iso(value) -> Optional[str]:
    if value is None:
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _storage():
    """The flow store, or a clean 503 rather than an unhandled 500.

    get_storage() raises if the store was never opened — which happens when the
    backend is unreachable at startup. That is a real state on a running
    install, and the panel should hear "the store is not available" rather than
    a bare internal error with nothing in it to act on.
    """
    from app.storage.factory import get_storage

    try:
        return get_storage()
    except RuntimeError as exc:
        raise ResonanceDataError(
            status_code=503,
            detail=("pktFlow's flow store is not available, so flow data cannot be read right "
                    "now. Alerts, sites and the application log are unaffected."),
        ) from exc


@router.get(
    f"{DATA_PREFIX}/summary",
    operation_id="getFlowSummary",
    summary="Is flow data arriving, and from where",
    description=(
        "One small result answering 'is collection healthy' — the current ingest rate, how many "
        "exporters have ever sent anything against how many sent in the last hour, the total "
        "volume and flow count in the last hour, how many sites are defined, and how many alerts "
        "are outstanding. Ask this first when the question is about pktFlow itself rather than "
        "about traffic; an exporter that stopped sending explains an empty search result better "
        "than any filter does."
    ),
    response_model=FlowSummary,
    responses=_ERRORS,
)
async def get_flow_summary(
    _user: dict = SessionUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    storage = _storage()
    devices = await _in_time(storage.get_device_summaries(), "read the exporter list")
    try:
        rate = await _in_time(storage.get_flows_per_sec(), "read the ingest rate")
    except ResonanceDataError:
        raise
    except Exception:
        rate = None

    async def _count(query: str) -> int:
        async with db.execute(query) as cur:
            row = await cur.fetchone()
        return (row[0] or 0) if row else 0

    active = [d for d in devices if (getattr(d, "flows_last_hour", 0) or 0) > 0]
    return {
        "flows_per_sec": rate,
        "sources": len(devices),
        "sources_active_last_hour": len(active),
        "bytes_last_hour": sum((getattr(d, "bytes_last_hour", 0) or 0) for d in devices),
        "flows_last_hour": sum((getattr(d, "flows_last_hour", 0) or 0) for d in devices),
        "sites": await _count("SELECT COUNT(*) FROM sites"),
        "unacknowledged_alerts": await _count(
            "SELECT COUNT(*) FROM alert_events WHERE acked_at IS NULL"
        ),
    }


@router.get(
    f"{DATA_PREFIX}/sources",
    operation_id="listFlowSources",
    summary="List the exporters sending flow records",
    description=(
        "Every device sending NetFlow or IPFIX here, with how much it sent in the last hour and "
        "when it was last heard from. Use this to turn a sampler address into a name, and to "
        "answer 'has that switch stopped exporting' — which is the usual reason a search comes "
        "back empty."
    ),
    response_model=FlowSourceList,
    responses=_ERRORS,
)
async def list_flow_sources(
    _user: dict = SessionUser,
):
    devices = await _in_time(_storage().get_device_summaries(), "read the exporter list")
    sources = []
    for d in devices:
        item = d.model_dump() if hasattr(d, "model_dump") else dict(d)
        item["last_seen"] = _iso(item.get("last_seen"))
        sources.append(item)
    return _fit({"total": len(sources), "sources": sources}, "sources")


@router.get(
    f"{DATA_PREFIX}/flows",
    operation_id="searchFlows",
    summary="Search individual flow records",
    description=(
        "Find flows between hosts, on ports, or over a protocol, newest first. `protocol` is the "
        "IANA number a flow record carries: 6 is TCP, 17 is UDP, 1 is ICMP. Set any_direction "
        "when the question is about a conversation rather than a direction — with one address it "
        "matches that host as source or destination, with two it matches the pair both ways "
        "round. The window defaults to the last hour and cannot be omitted; a wider one over a "
        "busy exporter matches millions of records, so `total` is the number that matched and "
        "the page is deliberately small. Narrow before widening."
    ),
    response_model=FlowSearchResultList,
    responses=_ERRORS,
)
async def search_flows(
    _user: dict = SessionUser,
    src_ip: Optional[str] = Query(None, max_length=64, description="Source address."),
    dst_ip: Optional[str] = Query(None, max_length=64, description="Destination address."),
    src_port: Optional[int] = Query(None, ge=0, le=65535, description="Source port."),
    dst_port: Optional[int] = Query(None, ge=0, le=65535, description="Destination port."),
    protocol: Optional[int] = Query(
        None, ge=0, le=255, description="IANA protocol number — 6 TCP, 17 UDP, 1 ICMP."
    ),
    sampler_ip: Optional[str] = Query(None, max_length=64, description="Only from this exporter."),
    window: TimeWindow = Query("1h", description="How far back to look. Default the last hour."),
    any_direction: bool = Query(
        False, description="Match the address filters in either direction — the whole conversation."
    ),
    limit: int = Query(
        _FLOW_DEFAULT, ge=1, le=_FLOW_MAX,
        description=f"How many to return. Default {_FLOW_DEFAULT}, maximum {_FLOW_MAX}.",
    ),
    offset: int = Query(0, ge=0, description="How many to skip, for paging."),
):
    storage = _storage()
    start, end = _window_bounds(window)
    filters = dict(src_ip=src_ip, dst_ip=dst_ip, src_port=src_port, dst_port=dst_port,
                   protocol=protocol, sampler_ip=sampler_ip, start=start, end=end,
                   any_direction=any_direction)

    total = await _in_time(storage.count_flows(**filters), "count matching flows")
    rows = await _in_time(
        storage.search_flows(**filters, limit=limit, offset=offset), "search flows"
    )

    flows = []
    for r in rows:
        item = r.model_dump() if hasattr(r, "model_dump") else dict(r)
        item["timestamp"] = _iso(item.get("timestamp"))
        # The stored record carries more NetFlow fields than the schema
        # declares; keep the declared ones so a page stays inside the budget.
        flows.append({k: item.get(k) for k in (
            "timestamp", "sampler_ip", "sampler_name", "src_ip", "dst_ip",
            "src_port", "dst_port", "protocol", "bytes", "packets", "duration_ms",
        )})

    return _fit(
        {"total": total, "limit": limit, "offset": offset,
         "window_start": _iso(start), "window_end": _iso(end), "flows": flows},
        "flows",
    )


@router.get(
    f"{DATA_PREFIX}/top-talkers",
    operation_id="getTopTalkers",
    summary="Rank source and destination pairs by volume",
    description=(
        "Who is moving the most traffic in a window, as source/destination pairs with the port "
        "and protocol. This is the 'what is eating the link' question, and it is almost always a "
        "better first move than searchFlows, which returns individual records. Highest volume "
        "first."
    ),
    response_model=TopTalkerList,
    responses=_ERRORS,
)
async def get_top_talkers(
    _user: dict = SessionUser,
    sampler_ip: Optional[str] = Query(None, max_length=64, description="Only from this exporter."),
    window: TimeWindow = Query("1h", description="How far back to look. Default the last hour."),
    limit: int = Query(
        _LIST_DEFAULT, ge=1, le=_LIST_MAX,
        description=f"How many pairs to return. Default {_LIST_DEFAULT}, maximum {_LIST_MAX}.",
    ),
):
    start, end = _window_bounds(window)
    rows = await _in_time(
        _storage().get_top_talkers(sampler_ip, start, end, limit), "rank top talkers"
    )
    talkers = []
    for r in rows:
        item = r.model_dump() if hasattr(r, "model_dump") else dict(r)
        item["megabytes"] = round((item.get("bytes") or 0) / (1024 ** 2), 2)
        talkers.append(item)

    return _fit(
        {"total": len(talkers), "window_start": _iso(start), "window_end": _iso(end),
         "talkers": talkers},
        "talkers",
    )


@router.get(
    f"{DATA_PREFIX}/sites",
    operation_id="listSites",
    summary="List the configured sites and their address ranges",
    description=(
        "The sites an administrator has defined and the address range each covers. Use this to "
        "turn an address into a place — 'which site is 10.20.0.0/16' — before reporting a flow "
        "or a talker back to somebody."
    ),
    response_model=SiteList,
    responses=_ERRORS,
)
async def list_sites(
    _user: dict = SessionUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    async with db.execute(
        "SELECT id, name, display_name, ip_cidr FROM sites ORDER BY name"
    ) as cur:
        rows = await cur.fetchall()
    sites = [dict(r) for r in rows]
    return _fit({"total": len(sites), "sites": sites}, "sites")


@router.get(
    f"{DATA_PREFIX}/alerts/events",
    operation_id="listAlertEvents",
    summary="List alerts that have fired",
    description=(
        "Individual firings of pktFlow's alert rules — a traffic threshold crossed, an exporter "
        "going silent, a pattern a rule watches for — newest first. This is what to read for "
        "'what is wrong' or 'what happened overnight'. An event with a null acked_at is one "
        "nobody has looked at yet; a null resolved_at means the condition has not cleared."
    ),
    response_model=AlertEventList,
    responses=_ERRORS,
)
async def list_alert_events(
    _user: dict = SessionUser,
    unacked_only: bool = Query(False, description="Only events nobody has acknowledged yet."),
    unresolved_only: bool = Query(False, description="Only events whose condition has not cleared."),
    severity: Optional[AlertSeverity] = Query(None, description="Only events raised at this severity."),
    since: Optional[str] = Query(None, description="Only events fired at or after this time. ISO 8601."),
    until: Optional[str] = Query(None, description="Only events fired at or before this time. ISO 8601."),
    limit: int = Query(
        _SEARCH_DEFAULT, ge=1, le=_SEARCH_MAX,
        description=f"How many to return. Default {_SEARCH_DEFAULT}, maximum {_SEARCH_MAX}.",
    ),
    offset: int = Query(0, ge=0, description="How many to skip, for paging."),
    db: aiosqlite.Connection = Depends(get_db),
):
    clauses: list[str] = []
    params: list = []
    if unacked_only:
        clauses.append("e.acked_at IS NULL")
    if unresolved_only:
        clauses.append("e.resolved_at IS NULL")
    if severity:
        clauses.append("e.severity = ?")
        params.append(severity)
    if since:
        # fired_at is written by SQLite's datetime('now') — space separated, no
        # 'Z' — so both sides go through datetime() to compare like for like.
        clauses.append("e.fired_at >= datetime(?)")
        params.append(since)
    if until:
        clauses.append("e.fired_at <= datetime(?)")
        params.append(until)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    async with db.execute(f"SELECT COUNT(*) FROM alert_events e {where}", params) as cur:
        total = (await cur.fetchone())[0]

    async with db.execute(
        f"""SELECT e.id, e.rule_id, e.severity, e.message, e.fired_at, e.acked_at,
                   e.resolved_at, e.auto_resolved, r.name AS rule_name
            FROM alert_events e
            LEFT JOIN alert_rules r ON r.id = e.rule_id
            {where}
            ORDER BY e.fired_at DESC
            LIMIT ? OFFSET ?""",
        params + [limit, offset],
    ) as cur:
        rows = await cur.fetchall()

    return _fit(
        {"total": total, "limit": limit, "offset": offset, "events": [dict(r) for r in rows]},
        "events",
    )


@router.get(
    f"{DATA_PREFIX}/alerts/rules",
    operation_id="listAlertRules",
    summary="List the configured alert rules",
    description=(
        "The rules an administrator has set up, whether each is switched on, what it watches and "
        "when it last fired. Rules are the configuration; listAlertEvents is what they have "
        "actually fired. Read this to answer 'are we even watching for that', and to get the "
        "rule id toggleAlertRule needs."
    ),
    response_model=AlertRuleList,
    responses=_ERRORS,
)
async def list_alert_rules(
    _user: dict = SessionUser,
    enabled_only: bool = Query(False, description="Only rules that are currently switched on."),
    db: aiosqlite.Connection = Depends(get_db),
):
    where = "WHERE enabled = 1" if enabled_only else ""
    async with db.execute(
        f"SELECT id, name, description, rule_type, severity, enabled, time_window_min, "
        f"cooldown_min, last_fired, created_at FROM alert_rules {where} ORDER BY name"
    ) as cur:
        rows = await cur.fetchall()
    rules = []
    for r in rows:
        d = dict(r)
        d["enabled"] = bool(d.get("enabled"))
        rules.append(d)
    return _fit({"total": len(rules), "rules": rules}, "rules")


@router.get(
    f"{DATA_PREFIX}/app-log",
    operation_id="searchApplicationLog",
    summary="Search pktFlow's own diagnostic log",
    description=(
        "pktFlow's internal log — what the application itself did and any errors it hit. This is "
        "NOT flow data: for traffic use searchFlows or getTopTalkers, and for alert firings use "
        "listAlertEvents. Read this to answer 'why did ingest stop' or 'what went wrong at three "
        "this morning'. Newest first."
    ),
    response_model=AppLogResult,
    responses=_ERRORS,
)
async def search_application_log(
    _user: dict = SessionUser,
    level: Optional[LogLevel] = Query(None, description="Only lines at this level."),
    logger: Optional[str] = Query(
        None, max_length=120, description="Only lines from loggers with this prefix."
    ),
    search: Optional[str] = Query(None, max_length=200, description="Substring of the message."),
    since: Optional[str] = Query(None, description="Only lines at or after this time. ISO 8601."),
    until: Optional[str] = Query(None, description="Only lines at or before this time. ISO 8601."),
    limit: int = Query(
        _SEARCH_DEFAULT, ge=1, le=_SEARCH_MAX,
        description=f"How many to return. Default {_SEARCH_DEFAULT}, maximum {_SEARCH_MAX}.",
    ),
    offset: int = Query(0, ge=0, description="How many to skip, for paging."),
    db: aiosqlite.Connection = Depends(get_db),
):
    clauses: list[str] = []
    params: list = []
    if level:
        clauses.append("level = ?")
        params.append(level)
    if logger:
        clauses.append("logger LIKE ?")
        params.append(f"{logger}%")
    if search:
        clauses.append("message LIKE ?")
        params.append(f"%{search}%")
    if since:
        clauses.append("ts >= ?")
        params.append(since)
    if until:
        clauses.append("ts <= ?")
        params.append(until)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    async with db.execute(f"SELECT COUNT(*) FROM app_logs {where}", params) as cur:
        total = (await cur.fetchone())[0]

    # The column is `ts` in this app and `created_at` in others; aliased so the
    # published field name is the same wherever the assistant is talking.
    async with db.execute(
        f"SELECT id, level, logger, message, ts AS created_at FROM app_logs {where} "
        "ORDER BY id DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    ) as cur:
        rows = await cur.fetchall()

    return _fit(
        {"total": total, "limit": limit, "offset": offset, "records": [dict(r) for r in rows]},
        "records",
    )


# ── The two documents ─────────────────────────────────────────────────────────
#
# Neither carries data — only names — so both are readable without a login, in
# the same way this app already publishes its own /openapi.json. Publishing them
# grants nothing on its own: an operation is reachable only because it is in
# GRANTED, and reachable only to a signed-in person whose role an admin listed.


def _declared_operation_ids(app) -> set[str]:
    """operationIds actually registered on the app.

    Walks the route table rather than calling app.openapi(), which would build
    and cache the schema at import time — before the SPA catch-all is mounted.

    The walk recurses because the table is not reliably flat: recent FastAPI
    keeps an included router as a single wrapper object holding its own routes,
    where earlier versions spliced them straight in. pkt installs pin only a
    lower bound on fastapi, so both layouts are live in the field and a walker
    that understood one of them would have reported every operation missing on
    the other.
    """
    found: set[str] = set()
    seen: set[int] = set()

    def walk(routes) -> None:
        for route in routes or []:
            if id(route) in seen:
                continue
            seen.add(id(route))
            op = getattr(route, "operation_id", None)
            if op:
                found.add(op)
            nested = getattr(route, "routes", None)
            if nested is None:
                inner = getattr(route, "original_router", None)
                nested = getattr(inner, "routes", None) if inner is not None else None
            if nested:
                walk(nested)

    walk(getattr(app, "routes", []))
    return found


def validate_grants(app) -> list[str]:
    """Fail loudly at startup when a grant names an operation that is not there.

    A grant for a route that has been renamed is the quiet failure mode of this
    whole arrangement: the panel asks for it, gets a 404, and reports the app as
    having no such capability rather than as misconfigured. Returns the missing
    names so a caller can act on them; logs them either way.
    """
    declared = _declared_operation_ids(app)
    missing = [g.op for g in GRANTED if g.op not in declared]
    if missing:
        log.error(
            "resonance grant names %d operation(s) this app does not declare: %s — "
            "they are being withheld from /.well-known/resonance.json",
            len(missing), ", ".join(missing),
        )
    return missing


async def writes_are_enabled(db: aiosqlite.Connection) -> bool:
    """True when at least one role has been trusted with more than reading.

    The grant is one document for the whole origin and is served without a
    login, so it cannot vary per person — but it can tell the truth about the
    install. Where no role is set to "write", the write operations are withheld
    from it entirely rather than advertised and refused on every attempt.
    """
    for role in ("admin", "analyst", "viewer"):
        if LEVEL_RANK.get(await role_level(db, role), 0) >= LEVEL_RANK["write"]:
            return True
    return False


def build_grant(app, allow_writes: bool) -> dict:
    """The grant document, generated from GRANTED so the two cannot disagree."""
    declared = _declared_operation_ids(app)
    allow: list[dict] = []
    for g in GRANTED:
        if g.op not in declared:
            continue
        if g.writes and not allow_writes:
            continue
        entry: dict[str, Any] = {"op": g.op}
        if g.writes:
            entry["writes"] = True
        allow.append(entry)
    return {"resonance": 1, "spec": SPEC_PATH, "allow": allow}


def _referenced_schemas(node: Any, out: set[str]) -> None:
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
            out.add(ref.rsplit("/", 1)[-1])
        for value in node.values():
            _referenced_schemas(value, out)
    elif isinstance(node, list):
        for value in node:
            _referenced_schemas(value, out)


def build_spec(app, allow_writes: bool) -> dict:
    """This app's own OpenAPI, narrowed to the granted operations.

    Generated from the live routes rather than written by hand, so a parameter
    that changes shape changes here too — the failure a hand-kept spec always
    ends in is the assistant confidently sending a field that stopped existing.
    Narrowed rather than published whole because everything an operation's prose
    has to compete with is another operation's prose: a hundred and twenty of
    them, most of which the grant forbids, is a hundred and twenty chances to
    pick the wrong one.
    """
    full = app.openapi()
    granted = {g.op for g in GRANTED if allow_writes or not g.writes}

    paths: dict[str, dict] = {}
    for path, item in (full.get("paths") or {}).items():
        # Deep-copied because app.openapi() hands back the app's own cached
        # schema object: editing an operation in place here would edit the
        # document this app publishes at /openapi.json as well.
        kept = {
            method: copy.deepcopy(operation)
            for method, operation in item.items()
            if isinstance(operation, dict) and operation.get("operationId") in granted
        }
        if kept:
            for operation in kept.values():
                # Nothing is presented on these calls but the person's own
                # session cookie, which the browser attaches by itself.
                operation.pop("security", None)
            paths[path] = kept

    wanted: set[str] = set()
    _referenced_schemas(paths, wanted)
    all_schemas = (full.get("components") or {}).get("schemas") or {}
    resolved: dict[str, Any] = {}
    while wanted:
        name = wanted.pop()
        if name in resolved or name not in all_schemas:
            continue
        resolved[name] = copy.deepcopy(all_schemas[name])
        nested: set[str] = set()
        _referenced_schemas(all_schemas[name], nested)
        wanted |= nested - resolved.keys()

    spec: dict[str, Any] = {
        "openapi": full.get("openapi", "3.1.0"),
        "info": {
            "title": "pktFlow — assistant data surface",
            "version": full.get("info", {}).get("version", "0.1.0"),
            "description": (
                "The operations pktFlow publishes for an embedded assistant. Every call is made "
                "by pktFlow's own page, same-origin, on the session of the person already signed "
                "in, so nothing here can reach data that person could not already open in the "
                "interface. No private key, passcode or certificate PEM is exposed, and nothing "
                "here issues, revokes, signs or approves anything."
            ),
        },
        "paths": paths,
    }
    if resolved:
        spec["components"] = {"schemas": resolved}
    return spec


# Two possible documents — with writes and without — so the setting can change
# without a restart while the expensive part is still built once each.
_spec_cache: dict[bool, Any] = {}


@router.get(GRANT_PATH, include_in_schema=False)
async def resonance_grant(request: Request, db: aiosqlite.Connection = Depends(get_db)):
    """What this install permits the assistant to call. Names only, no data.

    Public by contract: it has to be readable before anyone signs in, and it
    carries nothing but operation names. Whether the write operations appear
    depends on the levels an admin set, so an install that has trusted nobody
    with writes publishes a grant that cannot be read as offering them.
    """
    grant = build_grant(request.app, await writes_are_enabled(db))
    log.info("resonance grant fetched: %d operation(s), %d writing",
             len(grant["allow"]), sum(1 for a in grant["allow"] if a.get("writes")))
    return JSONResponse(
        grant,
        media_type="application/json",
        headers={"Cache-Control": "public, max-age=300"},
    )


@router.get(SPEC_PATH, include_in_schema=False)
async def resonance_spec(request: Request, db: aiosqlite.Connection = Depends(get_db)):
    """The OpenAPI document for the granted operations."""
    allow_writes = await writes_are_enabled(db)
    if allow_writes not in _spec_cache:
        _spec_cache[allow_writes] = build_spec(request.app, allow_writes)
    log.info("resonance spec fetched (writes %s)", "included" if allow_writes else "withheld")
    return JSONResponse(
        _spec_cache[allow_writes],
        media_type="application/json",
        headers={"Cache-Control": "public, max-age=300"},
    )


# ── Operations that change something ──────────────────────────────────────────
#
# Every one of these is marked `writes: true` in the grant, so resonance stops
# and reads the actual values back to the person before it runs one. That
# confirmation is theirs to enforce and cannot be relied on here, which is why
# both gates above still apply on the request itself.
#
# What is deliberately absent is as much of the design as what is present: no
# delete of anything, no clearing of logs, and no creating or editing of
# configuration. An assistant can act on what an administrator already put
# there, and cannot author or destroy it.


class AckResult(BaseModel):
    model_config = ConfigDict(extra="allow")
    event_id: int = Field(description="The alert event this refers to.")
    acknowledged: bool = Field(description="True if this call acknowledged it.")
    already_acknowledged: bool = Field(
        description="True when someone had already acknowledged it, in which case nothing changed."
    )
    acked_at: Optional[str] = Field(None, description="When it was acknowledged (ISO 8601, UTC).")
    message: str = Field(description="What happened, phrased to be read back to the person.")


class AckAllResult(BaseModel):
    model_config = ConfigDict(extra="allow")
    acknowledged: int = Field(description="How many outstanding alerts this call acknowledged.")
    message: str = Field(description="What happened, phrased to be read back to the person.")


@router.post(
    f"{DATA_PREFIX}/alerts/events/{{event_id}}/ack",
    operation_id="ackAlertEvent",
    summary="Acknowledge one alert",
    description=(
        "Mark a single fired alert as seen, recording who did it and when. This changes state. It "
        "does not resolve the alert or fix the condition behind it — a certificate close to "
        "expiry is still close to expiry, and the rule will fire again. Acknowledging something "
        "already acknowledged changes nothing and says so. Available to analysts and "
        "administrators, as in the interface."
    ),
    response_model=AckResult,
    responses={**_ERRORS, 404: {"model": ErrorResponse, "description": "No alert event with that id."}},
)
async def ack_alert_event(
    event_id: int = Path(
        description="Id of the alert event to acknowledge, as returned by listAlertEvents."
    ),
    user: dict = WriteUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    # pktFlow lets any signed-in person acknowledge an alert in the interface,
    # so there is no further role rule to mirror here — the assistant-level
    # gate above is the whole of it.

    async with db.execute(
        "SELECT e.acked_at, r.name FROM alert_events e "
        "LEFT JOIN alert_rules r ON r.id = e.rule_id WHERE e.id = ?",
        (event_id,),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise ResonanceDataError(status_code=404, detail=f"There is no alert event {event_id}.")

    name = row["name"] or "unnamed rule"
    if row["acked_at"]:
        when = str(row["acked_at"] or "").replace(" ", "T") + "Z" if row["acked_at"] else None
        return {
            "event_id": event_id, "acknowledged": False, "already_acknowledged": True,
            "acked_at": when,
            "message": f"Alert {event_id} ({name}) was already acknowledged"
                       + (f" at {when}." if when else "."),
        }

    await db.execute(
        "UPDATE alert_events SET acked_at = datetime('now'), acked_by = ? "
        "WHERE id = ? AND acked_at IS NULL",
        (user.get("id"), event_id),
    )
    await db.commit()

    async with db.execute("SELECT acked_at FROM alert_events WHERE id = ?", (event_id,)) as cur:
        acked = (await cur.fetchone())["acked_at"]
    when = str(acked).replace(" ", "T") + "Z" if acked else None
    log.info("resonance: %s acknowledged alert event %s", user.get("username"), event_id)
    return {
        "event_id": event_id, "acknowledged": True, "already_acknowledged": False,
        "acked_at": when,
        "message": f"Acknowledged alert {event_id} ({name}). The condition behind it is unchanged.",
    }


@router.post(
    f"{DATA_PREFIX}/alerts/events/ack-all",
    operation_id="ackAllAlertEvents",
    summary="Acknowledge every outstanding alert",
    description=(
        "Mark every alert nobody has acknowledged yet as seen, in one go. This changes state, and "
        "it is not reversible from here — there is no un-acknowledge. It resolves nothing: every "
        "condition behind every alert is untouched. Reports how many were acknowledged, which is "
        "zero when there was nothing outstanding. Available to analysts and administrators, as in "
        "the interface."
    ),
    response_model=AckAllResult,
    responses=_ERRORS,
)
async def ack_all_alert_events(
    user: dict = WriteUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    # pktFlow lets any signed-in person acknowledge an alert in the interface,
    # so there is no further role rule to mirror here — the assistant-level
    # gate above is the whole of it.

    async with db.execute("SELECT COUNT(*) FROM alert_events WHERE acked_at IS NULL") as cur:
        outstanding = (await cur.fetchone())[0]
    if not outstanding:
        return {"acknowledged": 0, "message": "There were no unacknowledged alerts."}

    await db.execute(
        "UPDATE alert_events SET acked_at = datetime('now'), acked_by = ? "
        "WHERE acked_at IS NULL",
        (user.get("id"),),
    )
    await db.commit()
    log.info("resonance: %s acknowledged all %d outstanding alerts",
             user.get("username"), outstanding)
    return {
        "acknowledged": outstanding,
        "message": f"Acknowledged {outstanding} alert"
                   f"{'' if outstanding == 1 else 's'}. None of the conditions behind them changed.",
    }


class ToggleRuleResult(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: int = Field(description="The rule that was switched.")
    name: Optional[str] = Field(None, description="Its name, for reading back.")
    enabled: bool = Field(description="Whether the rule is now on.")
    message: str = Field(description="What happened, phrased to be read back to the person.")


@router.post(
    f"{DATA_PREFIX}/alerts/rules/{{rule_id}}/toggle",
    operation_id="toggleAlertRule",
    summary="Switch an existing alert rule on or off",
    description=(
        "Turn a rule an administrator already created on, or off. This changes state. Switching a "
        "rule off stops it firing at all, so anything it was watching for goes unreported until "
        "it is switched back on — say which rule and which direction before doing it. It cannot "
        "create, edit or delete a rule, only flip the one switch. Administrators only, as in the "
        "interface."
    ),
    response_model=ToggleRuleResult,
    responses={**_ERRORS, 404: {"model": ErrorResponse, "description": "No alert rule with that id."}},
)
async def toggle_alert_rule(
    rule_id: int = Path(description="Id of the rule to switch, as returned by listAlertRules."),
    user: dict = WriteUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    await _apply_app_rule(user, require_analyst, "change alert rules")

    async with db.execute("SELECT id, name, enabled FROM alert_rules WHERE id = ?", (rule_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise ResonanceDataError(status_code=404, detail=f"There is no alert rule {rule_id}.")

    new_enabled = 0 if row["enabled"] else 1
    await db.execute("UPDATE alert_rules SET enabled = ? WHERE id = ?", (new_enabled, rule_id))
    await db.commit()
    log.info("resonance: %s switched alert rule %s %s",
             user.get("username"), rule_id, "on" if new_enabled else "off")
    return {
        "id": rule_id,
        "name": row["name"],
        "enabled": bool(new_enabled),
        "message": f"Alert rule {rule_id} ({row['name']}) is now "
                   f"{'on' if new_enabled else 'off'}.",
    }
