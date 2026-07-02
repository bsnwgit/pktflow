"""
VPN site mappings — CRUD endpoints.

Maps RFC-1918 subnets / individual IPs to a public firewall IP so that
the geo map can place private-IP traffic at the correct physical location
and classify arc lines as GP, S2S, or WAN.

All users can list mappings (GET).
Only admins can create, update, or delete (POST, PUT, DELETE).
"""
from __future__ import annotations

import aiosqlite
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.database import DB_PATH
from app.dependencies import CurrentUser, AdminUser

router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────

class VpnMappingIn(BaseModel):
    site_name:  str
    group_name: str
    public_ip:  str
    cidr_or_ip: str
    entry_type: str  # must match a traffic_types.name value


class VpnMapping(VpnMappingIn):
    id:         int
    created_at: str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/", response_model=list[VpnMapping])
async def list_vpn_mappings(_: CurrentUser):
    """Return all VPN site mappings ordered by group / site / type."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM vpn_mappings ORDER BY group_name, site_name, entry_type, cidr_or_ip"
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/", response_model=VpnMapping, status_code=201)
async def create_vpn_mapping(_: AdminUser, body: VpnMappingIn):
    """Add a new VPN mapping entry (admin only)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        try:
            await db.execute(
                """INSERT INTO vpn_mappings
                   (site_name, group_name, public_ip, cidr_or_ip, entry_type)
                   VALUES (?, ?, ?, ?, ?)""",
                (body.site_name, body.group_name, body.public_ip,
                 body.cidr_or_ip, body.entry_type),
            )
            await db.commit()
            async with db.execute(
                "SELECT * FROM vpn_mappings WHERE cidr_or_ip = ?", (body.cidr_or_ip,)
            ) as cur:
                row = await cur.fetchone()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return dict(row)


@router.put("/{mapping_id}", response_model=VpnMapping)
async def update_vpn_mapping(_: AdminUser, mapping_id: int, body: VpnMappingIn):
    """Update an existing VPN mapping (admin only)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id FROM vpn_mappings WHERE id = ?", (mapping_id,)
        ) as cur:
            if not await cur.fetchone():
                raise HTTPException(status_code=404, detail="Mapping not found")
        try:
            await db.execute(
                """UPDATE vpn_mappings
                   SET site_name=?, group_name=?, public_ip=?, cidr_or_ip=?, entry_type=?
                   WHERE id=?""",
                (body.site_name, body.group_name, body.public_ip,
                 body.cidr_or_ip, body.entry_type, mapping_id),
            )
            await db.commit()
            async with db.execute(
                "SELECT * FROM vpn_mappings WHERE id = ?", (mapping_id,)
            ) as cur:
                row = await cur.fetchone()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return dict(row)


@router.delete("/{mapping_id}", status_code=204)
async def delete_vpn_mapping(_: AdminUser, mapping_id: int):
    """Delete a VPN mapping entry (admin only)."""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id FROM vpn_mappings WHERE id = ?", (mapping_id,)
        ) as cur:
            if not await cur.fetchone():
                raise HTTPException(status_code=404, detail="Mapping not found")
        await db.execute("DELETE FROM vpn_mappings WHERE id = ?", (mapping_id,))
        await db.commit()
    return None
