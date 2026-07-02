"""
pktFlow — FastAPI application entry point.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.database import init_db
from app.storage.factory import init_storage, get_storage
from app.ingest.buffer import IngestBuffer

# ── Routers ───────────────────────────────────────────────────────────────────
from app.api import ingest, flows, devices, alerts, settings as settings_router, auth, users, ai, system as system_router, ws as ws_router
from app.api import logs as logs_router
from app.api import suite as suite_router
from app.api import vpn_mappings as vpn_mappings_router
from app.api import geo_config    as geo_config_router

settings = get_settings()
log = logging.getLogger("pktflow")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown logic."""
    # ── Startup ───────────────────────────────────────────────────────────────
    # Attach SQLite log handler FIRST so subsequent startup messages are captured
    from app.logging_handler import SQLiteLogHandler
    _log_handler = SQLiteLogHandler(db_path=settings.db_path)
    _log_handler.attach_to_root_logger("pktflow")

    log.info("pktFlow starting up")

    # Run SQLite migrations
    await init_db()
    log.info("Database migrations applied")

    # Connect to flow storage backend
    await init_storage()
    log.info(f"Flow storage ready: {get_storage().__class__.__name__}")

    # Start ingest buffer flush scheduler
    buffer = IngestBuffer.get_instance()
    await buffer.start()
    log.info("Ingest buffer started")

    # Start alert engine
    from app.alerts.engine import AlertEngine
    engine = AlertEngine()
    await engine.start()
    log.info("Alert engine started")

    # Start alert event cleanup job
    from app.alerts.cleanup import AlertCleanup
    cleanup = AlertCleanup()
    await cleanup.start()
    log.info("Alert cleanup started")

    # Start backup scheduler
    from app.backup import BackupScheduler
    backup_scheduler = BackupScheduler()
    await backup_scheduler.start()
    log.info("Backup scheduler started")

    # Start UDP NetFlow listener if ingest_method is "udp" or "both"
    udp_listener = None
    try:
        import aiosqlite as _aiosqlite
        import json as _json
        _db_path = Path(__file__).parent.parent / "pktflow.db"
        async with _aiosqlite.connect(str(_db_path)) as _db:
            async with _db.execute(
                "SELECT key, value FROM settings WHERE key IN ('ingest_method', 'ingest_udp_port_netflow')"
            ) as _cur:
                _rows = {r[0]: _json.loads(r[1]) for r in await _cur.fetchall()}
        _method = _rows.get("ingest_method", "http")
        if _method in ("udp", "both"):
            _port = int(_rows.get("ingest_udp_port_netflow", 2055))
            from app.ingest.udp_listener import UDPNetFlowListener
            udp_listener = UDPNetFlowListener()
            await udp_listener.start(port=_port)
            log.info("UDP NetFlow listener active on port %d", _port)
    except Exception as _e:
        log.warning("UDP listener not started: %s", _e)

    yield

    # ── Shutdown ──────────────────────────────────────────────────────────────
    log.info("pktFlow shutting down")
    if udp_listener:
        await udp_listener.stop()
    await buffer.stop()
    await engine.stop()
    await cleanup.stop()
    await backup_scheduler.stop()
    storage = get_storage()
    if hasattr(storage, "close"):
        await storage.close()
    log.info("Shutdown complete")
    _log_handler.stop()


# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="pktFlow",
    description="Enterprise NetFlow Visualization & Alerting Platform",
    version="0.1.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    lifespan=lifespan,
)

# ── Middleware ────────────────────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── API Routers ───────────────────────────────────────────────────────────────

app.include_router(auth.router,            prefix="/api/auth",     tags=["auth"])
app.include_router(users.router,           prefix="/api/users",    tags=["users"])
app.include_router(ingest.router,          prefix="/api/ingest",   tags=["ingest"])
app.include_router(flows.router,           prefix="/api/flows",    tags=["flows"])
app.include_router(devices.router,         prefix="/api/devices",  tags=["devices"])
app.include_router(alerts.router,          prefix="/api/alerts",   tags=["alerts"])
app.include_router(settings_router.router, prefix="/api/settings", tags=["settings"])
app.include_router(ai.router,              prefix="/api/ai",       tags=["ai"])
app.include_router(system_router.router,   prefix="/api/system",   tags=["system"])
app.include_router(logs_router.router,     prefix="/api/logs",     tags=["logs"])
app.include_router(ws_router.router,       prefix="/api",          tags=["ws"])
app.include_router(suite_router.router,         prefix="/api/suite",         tags=["suite"])
app.include_router(vpn_mappings_router.router,  prefix="/api/vpn-mappings",  tags=["vpn-mappings"])
app.include_router(geo_config_router.router,    prefix="/api/geo-config",    tags=["geo-config"])

# ── Health check ──────────────────────────────────────────────────────────────

@app.get("/api/health", tags=["system"])
async def health():
    return {"status": "ok", "version": "0.1.0"}

# ── Serve React frontend (production build) ───────────────────────────────────
# In development, Vite's dev server handles this on a different port.
_frontend_dist = Path(__file__).parent.parent / "frontend" / "dist"
if _frontend_dist.exists():
    # Serve static assets (JS, CSS, images) from /assets
    app.mount("/assets", StaticFiles(directory=str(_frontend_dist / "assets")), name="assets")

    # Serve public static files (logos, favicons, etc.)
    _logos_dir = _frontend_dist / "logos"
    if _logos_dir.exists():
        app.mount("/logos", StaticFiles(directory=str(_logos_dir)), name="logos")

    # Catch-all: serve index.html for all non-API routes (SPA client-side routing)
    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(request: Request, full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        index = _frontend_dist / "index.html"
        response = FileResponse(str(index))
        # pktHub suite-token bootstrap — set sso cookies so React logs in automatically
        _cfg = settings
        _suite_tk = request.headers.get("x-suite-token", "")
        if _suite_tk and _cfg.suite_token and _suite_tk == _cfg.suite_token:
            from datetime import datetime, timedelta, timezone
            from jose import jwt as _jose_jwt
            from app.dependencies import _SUITE_ROLE_MAP
            _hub_user = request.headers.get("x-suite-user", "hub_user")
            _hub_role = request.headers.get("x-suite-role", "viewer")
            _local_role = _SUITE_ROLE_MAP.get(_hub_role, "viewer")
            _expire = datetime.now(tz=timezone.utc) + timedelta(hours=8)
            _payload = {"sub": "0", "role": _local_role, "exp": _expire, "type": "access"}
            _jwt = _jose_jwt.encode(_payload, _cfg.secret_key, algorithm=_cfg.algorithm)
            response.set_cookie("sso_access_token", _jwt,       max_age=60, httponly=False, samesite="lax")
            response.set_cookie("sso_role",         _local_role, max_age=60, httponly=False, samesite="lax")
        return response


# ── Entrypoint (used by systemd: python -m app.main) ─────────────────────────
if __name__ == "__main__":
    import json
    import sqlite3
    import uvicorn

    # Read SSL settings from SQLite before uvicorn starts
    _db_path = Path(__file__).parent.parent / "pktflow.db"
    _ssl_enabled = False
    _ssl_certfile = None
    _ssl_keyfile = None
    try:
        _conn = sqlite3.connect(str(_db_path))
        for _key in ("ssl_enabled", "ssl_certfile", "ssl_keyfile"):
            _row = _conn.execute("SELECT value FROM settings WHERE key=?", (_key,)).fetchone()
            if _row:
                _val = json.loads(_row[0])
                if _key == "ssl_enabled":
                    _ssl_enabled = bool(_val)
                elif _key == "ssl_certfile":
                    _ssl_certfile = _val if _val else None
                elif _key == "ssl_keyfile":
                    _ssl_keyfile = _val if _val else None
        _conn.close()
    except Exception as _e:
        log.warning(f"Could not read SSL settings from DB: {_e}. Starting without SSL.")

    _uvicorn_kwargs: dict = dict(
        host="0.0.0.0",
        port=8766,
        workers=1,
        log_level="info",
    )
    if _ssl_enabled and _ssl_certfile and _ssl_keyfile:
        _uvicorn_kwargs["ssl_certfile"] = _ssl_certfile
        _uvicorn_kwargs["ssl_keyfile"] = _ssl_keyfile
        log.info(f"SSL enabled — cert: {_ssl_certfile}")
    else:
        if _ssl_enabled:
            log.warning("SSL enabled in settings but cert/key paths are missing — starting without SSL.")

    uvicorn.run("app.main:app", **_uvicorn_kwargs)
