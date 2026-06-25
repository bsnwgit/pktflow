"""
CRUD /api/devices — device registry management.
"""
from __future__ import annotations

import csv
import io
import ipaddress

import aiosqlite
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel
from typing import Optional

from app.database import get_db
from app.dependencies import CurrentUser, AdminUser

router = APIRouter()


class DeviceIn(BaseModel):
    ip: str
    name: str
    site: str = ""
    notes: str = ""
    allowed: bool = True


class DeviceOut(BaseModel):
    id: int
    ip: str
    name: str
    site: str
    notes: str
    allowed: bool
    created_at: str
    updated_at: str


@router.get("/unknown-samplers")
async def get_unknown_samplers(_: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    """
    Return samplers that are actively sending flows but not yet in the device registry,
    split into two buckets: unknown (needs review) and dismissed.
    """
    from app.storage.factory import get_storage

    summaries = await get_storage().get_device_summaries()

    async with db.execute("SELECT ip FROM devices") as cur:
        managed_ips = {r[0] for r in await cur.fetchall()}

    async with db.execute("SELECT sampler_ip, dismissed_at FROM sampler_dismissals") as cur:
        dismissed_rows = await cur.fetchall()
    dismissed_map = {r[0]: r[1] for r in dismissed_rows}

    unknown = []
    for s in summaries:
        ip = s["sampler_ip"] if isinstance(s, dict) else s.sampler_ip
        if ip not in managed_ips and ip not in dismissed_map:
            unknown.append({
                "sampler_ip":    ip,
                "flows_per_sec": s["flows_per_sec"] if isinstance(s, dict) else s.flows_per_sec,
                "last_seen":     s["last_seen"]     if isinstance(s, dict) else s.last_seen,
            })

    dismissed = [{"sampler_ip": ip, "dismissed_at": ts} for ip, ts in dismissed_map.items()]
    return {"unknown": unknown, "dismissed": dismissed}


@router.get("/sites")
async def get_device_sites(_: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    """Return distinct non-empty site values from the devices table, sorted."""
    async with db.execute(
        "SELECT DISTINCT site FROM devices WHERE site != '' ORDER BY site"
    ) as cur:
        rows = await cur.fetchall()
    return [r[0] for r in rows]


@router.post("/dismiss/{sampler_ip}")
async def dismiss_sampler(
    sampler_ip: str,
    _: AdminUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Mark a sampler IP as dismissed — hides it from the Unknown Samplers review list."""
    await db.execute(
        "INSERT OR IGNORE INTO sampler_dismissals (sampler_ip) VALUES (?)",
        (sampler_ip,),
    )
    await db.commit()
    return {"dismissed": sampler_ip}


@router.delete("/dismiss/{sampler_ip}", status_code=status.HTTP_204_NO_CONTENT)
async def undismiss_sampler(
    sampler_ip: str,
    _: AdminUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Remove a sampler IP from the dismissed list — it will reappear in Unknown Samplers."""
    await db.execute(
        "DELETE FROM sampler_dismissals WHERE sampler_ip = ?", (sampler_ip,)
    )
    await db.commit()


@router.get("/", response_model=list[DeviceOut])
async def list_devices(_: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute("SELECT * FROM devices ORDER BY site, name") as cur:
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/", response_model=DeviceOut, status_code=status.HTTP_201_CREATED)
async def create_device(body: DeviceIn, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    try:
        async with db.execute(
            "INSERT INTO devices (ip, name, site, notes, allowed) VALUES (?, ?, ?, ?, ?) RETURNING *",
            (body.ip, body.name, body.site, body.notes, int(body.allowed)),
        ) as cur:
            row = await cur.fetchone()
        await db.commit()
        _refresh_cache(db)
        return dict(row)
    except aiosqlite.IntegrityError:
        raise HTTPException(status_code=409, detail=f"Device {body.ip} already exists")


@router.put("/{device_id}", response_model=DeviceOut)
async def update_device(
    device_id: int,
    body: DeviceIn,
    _: AdminUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    await db.execute(
        """UPDATE devices
           SET ip=?, name=?, site=?, notes=?, allowed=?, updated_at=datetime('now')
           WHERE id=?""",
        (body.ip, body.name, body.site, body.notes, int(body.allowed), device_id),
    )
    await db.commit()
    async with db.execute("SELECT * FROM devices WHERE id = ?", (device_id,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Device not found")
    _refresh_cache(db)
    return dict(row)


@router.post("/import", dependencies=[Depends(AdminUser)])
async def import_devices_csv(
    file: UploadFile = File(...),
    db: aiosqlite.Connection = Depends(get_db),
):
    """
    Bulk-import devices from a CSV file.
    Expected columns (header required): ip, name, site, notes, allowed
    Upsert behavior: existing IP → update; new IP → create.
    Returns { created, updated, skipped, errors }.
    """
    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")  # strip BOM if present
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File must be UTF-8 encoded")

    reader = csv.DictReader(io.StringIO(text))
    required = {"ip"}
    if not reader.fieldnames or not required.issubset({f.strip().lower() for f in reader.fieldnames}):
        raise HTTPException(status_code=400, detail="CSV must have at least an 'ip' column header")

    # Normalise header names (strip whitespace, lowercase)
    def get(row: dict, key: str, default: str = "") -> str:
        for k, v in row.items():
            if k.strip().lower() == key:
                return (v or "").strip()
        return default

    created = updated = skipped = 0
    errors: list[dict] = []

    for i, row in enumerate(reader, start=2):  # row 1 = header
        ip_raw = get(row, "ip")
        if not ip_raw:
            errors.append({"row": i, "reason": "Missing IP"})
            skipped += 1
            continue

        # Validate IP
        try:
            ipaddress.ip_address(ip_raw)
        except ValueError:
            errors.append({"row": i, "reason": f"Invalid IP: {ip_raw}"})
            skipped += 1
            continue

        name    = get(row, "name")
        site    = get(row, "site")
        notes   = get(row, "notes")
        allowed_raw = get(row, "allowed", "true").lower()
        allowed = 0 if allowed_raw in ("false", "0", "no", "blocked") else 1

        # Check if device already exists
        async with db.execute("SELECT id FROM devices WHERE ip = ?", (ip_raw,)) as cur:
            existing = await cur.fetchone()

        try:
            if existing:
                await db.execute(
                    """UPDATE devices
                       SET name=?, site=?, notes=?, allowed=?, updated_at=datetime('now')
                       WHERE ip=?""",
                    (name, site, notes, allowed, ip_raw),
                )
                updated += 1
            else:
                await db.execute(
                    "INSERT INTO devices (ip, name, site, notes, allowed) VALUES (?, ?, ?, ?, ?)",
                    (ip_raw, name, site, notes, allowed),
                )
                created += 1
        except Exception as e:
            errors.append({"row": i, "reason": str(e)})
            skipped += 1

    await db.commit()
    _refresh_cache(db)
    return {"created": created, "updated": updated, "skipped": skipped, "errors": errors}


@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_device(device_id: int, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    await db.execute("DELETE FROM devices WHERE id = ?", (device_id,))
    await db.commit()
    _refresh_cache(db)


def _refresh_cache(db):
    """Trigger normalizer device cache refresh asynchronously."""
    import asyncio
    asyncio.create_task(_do_refresh())


async def _do_refresh():
    from app.config import get_settings
    from app.ingest.normalizer import refresh_device_cache
    async with aiosqlite.connect(get_settings().db_path) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT ip, name, site FROM devices WHERE allowed = 1") as cur:
            rows = await cur.fetchall()
    refresh_device_cache([dict(r) for r in rows])
