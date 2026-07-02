"""
Geo Map configuration — CRUD endpoints for the three configurable tables:
  site_groups    — circle marker colours and badge styles keyed by group name
  line_styles    — arc line style catalog (colour + dash pattern)
  traffic_types  — named traffic classifications that reference a line style

All authenticated users can read (GET).
Only admins can write (POST, PUT, DELETE).
"""
from __future__ import annotations

import aiosqlite
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.database import DB_PATH
from app.dependencies import CurrentUser, AdminUser

router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────

class SiteGroupIn(BaseModel):
    name:         str
    display_name: str
    fill_color:   str
    stroke_color: str
    badge_bg:     str = 'bg-gray-700'
    badge_text:   str = 'text-gray-300'


class SiteGroup(SiteGroupIn):
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


class TrafficTypeIn(BaseModel):
    name:          str
    label:         str
    line_style_id: Optional[int] = None
    is_default:    bool = False


class TrafficType(BaseModel):
    id:            int
    name:          str
    label:         str
    line_style_id: Optional[int]
    is_default:    int          # 0 or 1 — kept as int for SQLite compat
    created_at:    str
    # Flattened from joined line_styles row
    line_color:    Optional[str] = None
    line_dash:     Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _get_one(db: aiosqlite.Connection, table: str, id_: int) -> aiosqlite.Row:
    async with db.execute(f"SELECT * FROM {table} WHERE id = ?", (id_,)) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"{table} id={id_} not found")
    return row


# ── Site Groups ───────────────────────────────────────────────────────────────

@router.get("/site-groups", response_model=list[SiteGroup])
async def list_site_groups(_: CurrentUser):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM site_groups ORDER BY name") as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/site-groups", response_model=SiteGroup, status_code=201)
async def create_site_group(_: AdminUser, body: SiteGroupIn):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        try:
            await db.execute(
                """INSERT INTO site_groups
                   (name, display_name, fill_color, stroke_color, badge_bg, badge_text)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (body.name, body.display_name, body.fill_color,
                 body.stroke_color, body.badge_bg, body.badge_text),
            )
            await db.commit()
            async with db.execute(
                "SELECT * FROM site_groups WHERE name = ?", (body.name,)
            ) as cur:
                row = await cur.fetchone()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return dict(row)


@router.put("/site-groups/{id}", response_model=SiteGroup)
async def update_site_group(_: AdminUser, id: int, body: SiteGroupIn):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await _get_one(db, "site_groups", id)
        try:
            await db.execute(
                """UPDATE site_groups
                   SET name=?, display_name=?, fill_color=?, stroke_color=?, badge_bg=?, badge_text=?
                   WHERE id=?""",
                (body.name, body.display_name, body.fill_color,
                 body.stroke_color, body.badge_bg, body.badge_text, id),
            )
            await db.commit()
            row = await _get_one(db, "site_groups", id)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return dict(row)


@router.delete("/site-groups/{id}", status_code=204)
async def delete_site_group(_: AdminUser, id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        await _get_one(db, "site_groups", id)
        await db.execute("DELETE FROM site_groups WHERE id = ?", (id,))
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


# ── Traffic Types ─────────────────────────────────────────────────────────────

@router.get("/traffic-types", response_model=list[TrafficType])
async def list_traffic_types(_: CurrentUser):
    """Return all traffic types with their line style colours flattened in."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT t.*, ls.color_hex AS line_color, ls.dash_pattern AS line_dash
               FROM traffic_types t
               LEFT JOIN line_styles ls ON ls.id = t.line_style_id
               ORDER BY t.is_default ASC, t.name"""
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/traffic-types", response_model=TrafficType, status_code=201)
async def create_traffic_type(_: AdminUser, body: TrafficTypeIn):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        try:
            await db.execute(
                "INSERT INTO traffic_types (name, label, line_style_id, is_default) VALUES (?, ?, ?, ?)",
                (body.name, body.label, body.line_style_id, 1 if body.is_default else 0),
            )
            await db.commit()
            async with db.execute(
                """SELECT t.*, ls.color_hex AS line_color, ls.dash_pattern AS line_dash
                   FROM traffic_types t
                   LEFT JOIN line_styles ls ON ls.id = t.line_style_id
                   WHERE t.name = ?""", (body.name,)
            ) as cur:
                row = await cur.fetchone()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return dict(row)


@router.put("/traffic-types/{id}", response_model=TrafficType)
async def update_traffic_type(_: AdminUser, id: int, body: TrafficTypeIn):
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await _get_one(db, "traffic_types", id)
        try:
            await db.execute(
                "UPDATE traffic_types SET name=?, label=?, line_style_id=?, is_default=? WHERE id=?",
                (body.name, body.label, body.line_style_id, 1 if body.is_default else 0, id),
            )
            await db.commit()
            async with db.execute(
                """SELECT t.*, ls.color_hex AS line_color, ls.dash_pattern AS line_dash
                   FROM traffic_types t
                   LEFT JOIN line_styles ls ON ls.id = t.line_style_id
                   WHERE t.id = ?""", (id,)
            ) as cur:
                row = await cur.fetchone()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return dict(row)


@router.delete("/traffic-types/{id}", status_code=204)
async def delete_traffic_type(_: AdminUser, id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        await _get_one(db, "traffic_types", id)
        await db.execute("DELETE FROM traffic_types WHERE id = ?", (id,))
        await db.commit()
    return None
