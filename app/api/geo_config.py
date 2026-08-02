"""
Geo Map configuration — CRUD endpoints for the two configurable catalogs:
  sites          — circle marker colours, badge styles, and IP/CIDR matching
                   keyed by site key
  line_styles    — arc line style catalog (colour + dash pattern), picked
                   directly by Address Mappings and Traffic Rules

Every install has exactly one Default site (name == 'default') that address
mappings fall back to. Its key is immutable — update_site rejects renaming
it away, delete_site refuses to delete it — but its display name, colors,
and ip_cidr stay fully editable.

All authenticated users can read (GET).
Only admins can write (POST, PUT, DELETE).
"""
from __future__ import annotations

import aiosqlite
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.database import DB_PATH
from app.dependencies import CurrentUser, AdminUser

router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────

class SiteIn(BaseModel):
    name:           str
    display_name:   str
    fill_color:     str
    stroke_color:   str
    badge_bg:       str = '#374151'
    badge_text:     str = '#d1d5db'
    show_in_legend: bool = True
    ip_cidr:        str = ''   # comma-separated IP/CIDR list; matches remote (public) traffic to this site


class Site(SiteIn):
    id:         int
    created_at: str


class LineStyleIn(BaseModel):
    name:         str
    label:        str
    color_hex:    str
    dash_pattern: str = ''


class LineStyle(LineStyleIn):
    id:         int
    created_at: str


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _get_one(db: aiosqlite.Connection, table: str, id_: int) -> aiosqlite.Row:
    async with db.execute(f"SELECT * FROM {table} WHERE id = ?", (id_,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"{table} id={id_} not found")
    return row


# ── Sites ─────────────────────────────────────────────────────────────────────

@router.get("/sites", response_model=list[Site])
async def list_sites(_: CurrentUser):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM sites ORDER BY name") as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/sites", response_model=Site, status_code=201)
async def create_site(_: AdminUser, body: SiteIn):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        try:
            await db.execute(
                """INSERT INTO sites
                   (name, display_name, fill_color, stroke_color, badge_bg, badge_text, show_in_legend, ip_cidr)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (body.name, body.display_name, body.fill_color, body.stroke_color,
                 body.badge_bg, body.badge_text, 1 if body.show_in_legend else 0, body.ip_cidr),
            )
            await db.commit()
            async with db.execute(
                "SELECT * FROM sites WHERE name = ?", (body.name,)
            ) as cur:
                row = await cur.fetchone()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return dict(row)


@router.put("/sites/{id}", response_model=Site)
async def update_site(_: AdminUser, id: int, body: SiteIn):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        existing = await _get_one(db, "sites", id)
        if existing["name"] == "default" and body.name != "default":
            raise HTTPException(status_code=400, detail="The Default site's key cannot be changed")
        try:
            await db.execute(
                """UPDATE sites
                   SET name=?, display_name=?, fill_color=?, stroke_color=?, badge_bg=?, badge_text=?, show_in_legend=?, ip_cidr=?
                   WHERE id=?""",
                (body.name, body.display_name, body.fill_color, body.stroke_color,
                 body.badge_bg, body.badge_text, 1 if body.show_in_legend else 0, body.ip_cidr, id),
            )
            await db.commit()
            row = await _get_one(db, "sites", id)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return dict(row)


@router.delete("/sites/{id}", status_code=204)
async def delete_site(_: AdminUser, id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        row = await _get_one(db, "sites", id)
        if row["name"] == "default":
            raise HTTPException(status_code=400, detail="The Default site cannot be deleted")
        # traffic_rules.dst_site_key -> sites(name) ON DELETE SET NULL would
        # otherwise silently null out a rule's only filter and violate its
        # "at least one filter" CHECK — block up front with a clear message
        # instead of letting that surface as a raw IntegrityError.
        async with db.execute(
            "SELECT name FROM traffic_rules WHERE dst_site_key = ?", (row["name"],)
        ) as cur:
            in_use = await cur.fetchone()
        if in_use:
            raise HTTPException(
                status_code=400,
                detail=f"Site is used as the Destination on Traffic Rule \"{in_use['name']}\" — update or delete that rule first",
            )
        await db.execute("DELETE FROM sites WHERE id = ?", (id,))
        await db.commit()
    return None


# ── Line Styles ───────────────────────────────────────────────────────────────

@router.get("/line-styles", response_model=list[LineStyle])
async def list_line_styles(_: CurrentUser):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM line_styles ORDER BY name") as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/line-styles", response_model=LineStyle, status_code=201)
async def create_line_style(_: AdminUser, body: LineStyleIn):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        try:
            await db.execute(
                "INSERT INTO line_styles (name, label, color_hex, dash_pattern) VALUES (?, ?, ?, ?)",
                (body.name, body.label, body.color_hex, body.dash_pattern),
            )
            await db.commit()
            async with db.execute(
                "SELECT * FROM line_styles WHERE name = ?", (body.name,)
            ) as cur:
                row = await cur.fetchone()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return dict(row)


@router.put("/line-styles/{id}", response_model=LineStyle)
async def update_line_style(_: AdminUser, id: int, body: LineStyleIn):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await _get_one(db, "line_styles", id)
        try:
            await db.execute(
                "UPDATE line_styles SET name=?, label=?, color_hex=?, dash_pattern=? WHERE id=?",
                (body.name, body.label, body.color_hex, body.dash_pattern, id),
            )
            await db.commit()
            row = await _get_one(db, "line_styles", id)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return dict(row)


@router.delete("/line-styles/{id}", status_code=204)
async def delete_line_style(_: AdminUser, id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        await _get_one(db, "line_styles", id)
        await db.execute("DELETE FROM line_styles WHERE id = ?", (id,))
        await db.commit()
    return None
