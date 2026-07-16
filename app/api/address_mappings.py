"""
Address Mappings — CRUD endpoints.

Maps a private CIDR/IP to a representative external CIDR/IP so the geo map
can place that traffic at the correct physical location. This is a pure
network-topology fact — it carries no visual styling of its own. Traffic
Rules is the only place a Line Style gets picked; see app/api/traffic_rules.py.
Replaces the old, separately-shaped vpn_mappings + wan_mappings tables — both
did the same job, `category` keeps the WAN/VPN distinction as a display-only
badge.

`priority` (lower wins) resolves conflicts when both ends of a flow match a
different entry — it decides which side's Traffic Rules get consulted. It is
never set directly by the client — new rows are appended to the end, and
reordering happens via POST /reorder, which is the only way priority values
change.

All users can list mappings (GET).
Only admins can create, update, delete, or reorder (POST, PUT, DELETE).
"""
from __future__ import annotations

import aiosqlite
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.database import DB_PATH
from app.dependencies import CurrentUser, AdminUser

router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────

class AddressMappingIn(BaseModel):
    name:          str
    group_name:    str
    category:      str  # 'wan' | 'vpn' — display badge only, no matching effect
    private_cidr:  str
    public_cidr:   str


class AddressMapping(AddressMappingIn):
    id:         int
    priority:   int
    created_at: str


class ReorderIn(BaseModel):
    ids: list[int]  # full ordered list of address_mappings.id, first = highest priority


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/", response_model=list[AddressMapping])
async def list_address_mappings(_: CurrentUser):
    """Return all address mappings ordered by priority (highest first)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM address_mappings ORDER BY priority, id"
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/", response_model=AddressMapping, status_code=201)
async def create_address_mapping(_: AdminUser, body: AddressMappingIn):
    """Add a new address mapping (admin only). Appended at the end of priority order."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        try:
            async with db.execute("SELECT COALESCE(MAX(priority) + 1, 0) FROM address_mappings") as cur:
                next_priority = (await cur.fetchone())[0]
            cur = await db.execute(
                """INSERT INTO address_mappings
                   (name, group_name, category, private_cidr, public_cidr, priority)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (body.name, body.group_name, body.category, body.private_cidr,
                 body.public_cidr, next_priority),
            )
            await db.commit()
            async with db.execute(
                "SELECT * FROM address_mappings WHERE id = ?", (cur.lastrowid,)
            ) as cur2:
                row = await cur2.fetchone()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return dict(row)


@router.put("/{mapping_id}", response_model=AddressMapping)
async def update_address_mapping(_: AdminUser, mapping_id: int, body: AddressMappingIn):
    """Update an existing address mapping (admin only). Priority is untouched — use /reorder."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id FROM address_mappings WHERE id = ?", (mapping_id,)
        ) as cur:
            if not await cur.fetchone():
                raise HTTPException(status_code=404, detail="Mapping not found")
        try:
            await db.execute(
                """UPDATE address_mappings
                   SET name=?, group_name=?, category=?, private_cidr=?, public_cidr=?
                   WHERE id=?""",
                (body.name, body.group_name, body.category, body.private_cidr,
                 body.public_cidr, mapping_id),
            )
            await db.commit()
            async with db.execute(
                "SELECT * FROM address_mappings WHERE id = ?", (mapping_id,)
            ) as cur:
                row = await cur.fetchone()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return dict(row)


@router.post("/reorder", response_model=list[AddressMapping])
async def reorder_address_mappings(_: AdminUser, body: ReorderIn):
    """Persist a drag-and-drop reorder (admin only) — rewrites priority 0..N-1
    to match the given id order. Must include every existing mapping's id."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT id FROM address_mappings") as cur:
            existing_ids = {r["id"] for r in await cur.fetchall()}
        if set(body.ids) != existing_ids:
            raise HTTPException(status_code=400, detail="ids must match the full current set of address mappings")
        try:
            for index, mapping_id in enumerate(body.ids):
                await db.execute(
                    "UPDATE address_mappings SET priority = ? WHERE id = ?", (index, mapping_id)
                )
            await db.commit()
            async with db.execute(
                "SELECT * FROM address_mappings ORDER BY priority, id"
            ) as cur:
                rows = await cur.fetchall()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return [dict(r) for r in rows]


@router.delete("/{mapping_id}", status_code=204)
async def delete_address_mapping(_: AdminUser, mapping_id: int):
    """Delete an address mapping (admin only)."""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id FROM address_mappings WHERE id = ?", (mapping_id,)
        ) as cur:
            if not await cur.fetchone():
                raise HTTPException(status_code=404, detail="Mapping not found")
        await db.execute("DELETE FROM address_mappings WHERE id = ?", (mapping_id,))
        await db.commit()
    return None
