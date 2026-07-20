"""
Production entrypoint — reads host/port from Settings (config.yaml) at
process start, instead of a fixed --port flag in the systemd unit. This is
what lets Settings → General "Port" actually take effect on restart: saving
just rewrites config.yaml, and the next process start picks it up here.
"""
from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path

import uvicorn

from app.config import get_settings

log = logging.getLogger("pktflow")


def main() -> None:
    settings = get_settings()

    # Read SSL settings from SQLite before uvicorn starts
    db_path = Path(__file__).parent.parent / "pktflow.db"
    ssl_enabled = False
    ssl_certfile = None
    ssl_keyfile = None
    try:
        conn = sqlite3.connect(str(db_path))
        for key in ("ssl_enabled", "ssl_certfile", "ssl_keyfile"):
            row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
            if row:
                val = json.loads(row[0])
                if key == "ssl_enabled":
                    ssl_enabled = bool(val)
                elif key == "ssl_certfile":
                    ssl_certfile = val if val else None
                elif key == "ssl_keyfile":
                    ssl_keyfile = val if val else None
        conn.close()
    except Exception as e:
        log.warning(f"Could not read SSL settings from DB: {e}. Starting without SSL.")

    uvicorn_kwargs: dict = dict(
        host=settings.host,
        port=settings.port,
        workers=1,
        log_level="info",
        access_log=False,
    )
    if ssl_enabled and ssl_certfile and ssl_keyfile:
        uvicorn_kwargs["ssl_certfile"] = ssl_certfile
        uvicorn_kwargs["ssl_keyfile"] = ssl_keyfile
        log.info(f"SSL enabled — cert: {ssl_certfile}")
    else:
        if ssl_enabled:
            log.warning("SSL enabled in settings but cert/key paths are missing — starting without SSL.")

    uvicorn.run("app.main:app", **uvicorn_kwargs)


if __name__ == "__main__":
    main()
