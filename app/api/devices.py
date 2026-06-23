"""
CRUD /api/devices — device registry management.
"""
from __future__ import annotations

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, status
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
