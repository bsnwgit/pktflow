"""
Geo Map configuration — CRUD endpoints for the two configurable catalogs:
  site_groups    — circle marker colours and badge styles keyed by group name
  line_styles    — arc line style catalog (colour + dash pattern), picked
                   directly by Address Mappings and Traffic Rules

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

class SiteGroupIn(BaseModel):
    name:           str
    display_name:   str
    fill_color:     str
    stroke_color:   str
    badge_bg:       str = '#374151'
    badge_text:     str = '#d1d5db'
    show_in_legend: bool = True


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
                   (name, display_name, fill_color, stroke_color, badge_bg, badge_text, show_in_legend)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (body.name, body.display_name, body.fill_color,
                 body.stroke_color, body.badge_bg, body.badge_text, 1 if body.show_in_legend else 0),
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
                   SET name=?, display_name=?, fill_color=?, stroke_color=?, badge_bg=?, badge_text=?, show_in_legend=?
                   WHERE id=?""",
                (body.name, body.display_name, body.fill_color,
                 body.stroke_color, body.badge_bg, body.badge_text, 1 if body.show_in_legend else 0, id),
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
