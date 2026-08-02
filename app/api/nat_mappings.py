"""
Private/Public NAT Mapping — CRUD endpoints.

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
change. Multiple rows may share the same private_cidr and/or public_cidr —
priority order is what resolves which one actually wins.

`dst_cidrs`/`dst_ports` (comma-separated, optional, same format as Traffic
Rules') let the same private_cidr resolve to a *different* public_cidr
depending on the flow's destination — e.g. a firewall that NATs DNS traffic
(dst port 53) out one public IP and everything else out another. Blank on
both = applies to any destination. app/api/flows.py matches these per flow
pair, first-hit-wins in priority order, same as Traffic Rules matching.

`show_in_legend` controls whether this mapping appears in the Geo Map's
Address Mappings legend section, same pattern as sites.show_in_legend.

When the isp_dhcp_enabled setting is on, every mapping here is locked
(PUT/DELETE rejected) — see app/api/settings.py, which owns creating and
deleting the single synthetic "Default" mapping used in that mode, and
app/api/flows.py, which ignores every other mapping while it's active.

All users can list mappings (GET).
Only admins can create, update, delete, or reorder (POST, PUT, DELETE).
"""
from __future__ import annotations

import ipaddress
import json
from typing import Optional

import aiosqlite
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from app.database import DB_PATH
from app.dependencies import CurrentUser, AdminUser

router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────

def _validate_cidrs(value: str) -> str:
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            ipaddress.ip_network(part, strict=False)
        except ValueError:
            try:
                ipaddress.ip_address(part)
            except ValueError:
                raise ValueError(f"'{part}' is not a valid IP address or CIDR")
    return value


def _validate_ports(value: str) -> str:
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo, _, hi = part.partition("-")
            if not (lo.strip().isdigit() and hi.strip().isdigit()):
                raise ValueError(f"'{part}' is not a valid port range")
            lo_i, hi_i = int(lo), int(hi)
            if not (0 <= lo_i <= 65535 and 0 <= hi_i <= 65535 and lo_i <= hi_i):
                raise ValueError(f"'{part}' is not a valid port range")
        else:
            if not part.isdigit() or not (0 <= int(part) <= 65535):
                raise ValueError(f"'{part}' is not a valid port")
    return value


class NatMappingIn(BaseModel):
    name:           str
    site_key:       str
    category:       str  # 'wan' | 'vpn' — display badge only, no matching effect
    private_cidr:   str
    public_cidr:    str
    dst_cidrs:      Optional[str] = None  # comma-separated IPs/CIDRs; blank = any destination
    dst_ports:      Optional[str] = None  # comma-separated ports/ranges; blank = any port
    show_in_legend: bool = True

    @field_validator("dst_cidrs")
    @classmethod
    def _check_cidrs(cls, v: Optional[str]) -> Optional[str]:
        return _validate_cidrs(v) if v else v

    @field_validator("dst_ports")
    @classmethod
    def _check_ports(cls, v: Optional[str]) -> Optional[str]:
        return _validate_ports(v) if v else v


class NatMapping(NatMappingIn):
    id:         int
    priority:   int
    created_at: str


class ReorderIn(BaseModel):
    ids: list[int]  # full ordered list of nat_mappings.id, first = highest priority


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _isp_dhcp_enabled(db: aiosqlite.Connection) -> bool:
    async with db.execute("SELECT value FROM settings WHERE key = 'isp_dhcp_enabled'") as cur:
        row = await cur.fetchone()
    return bool(json.loads(row[0])) if row else False


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/", response_model=list[NatMapping])
async def list_nat_mappings(_: CurrentUser):
    """Return all NAT mappings ordered by priority (highest first)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM nat_mappings ORDER BY priority, id"
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/", response_model=NatMapping, status_code=201)
async def create_nat_mapping(_: AdminUser, body: NatMappingIn):
    """Add a new NAT mapping (admin only). Appended at the end of priority order."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if await _isp_dhcp_enabled(db):
            raise HTTPException(status_code=400, detail="NAT mappings are locked while ISP DHCP mode is enabled")
        try:
            async with db.execute("SELECT COALESCE(MAX(priority) + 1, 0) FROM nat_mappings") as cur:
                next_priority = (await cur.fetchone())[0]
            cur = await db.execute(
                """INSERT INTO nat_mappings
                   (name, site_key, category, private_cidr, public_cidr, dst_cidrs, dst_ports, priority, show_in_legend)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (body.name, body.site_key, body.category, body.private_cidr, body.public_cidr,
                 body.dst_cidrs, body.dst_ports, next_priority, 1 if body.show_in_legend else 0),
            )
            await db.commit()
            async with db.execute(
                "SELECT * FROM nat_mappings WHERE id = ?", (cur.lastrowid,)
            ) as cur2:
                row = await cur2.fetchone()
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return dict(row)


@router.put("/{mapping_id}", response_model=NatMapping)
async def update_nat_mapping(_: AdminUser, mapping_id: int, body: NatMappingIn):
    """Update an existing NAT mapping (admin only). Priority is untouched — use /reorder."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if await _isp_dhcp_enabled(db):
            raise HTTPException(status_code=400, detail="NAT mappings are locked while ISP DHCP mode is enabled")
        async with db.execute(
            "SELECT id FROM nat_mappings WHERE id = ?", (mapping_id,)
        ) as cur:
            if not await cur.fetchone():
                raise HTTPException(status_code=404, detail="Mapping not found")
        try:
            await db.execute(
                """UPDATE nat_mappings
                   SET name=?, site_key=?, category=?, private_cidr=?, public_cidr=?, dst_cidrs=?, dst_ports=?, show_in_legend=?
                   WHERE id=?""",
                (body.name, body.site_key, body.category, body.private_cidr, body.public_cidr,
                 body.dst_cidrs, body.dst_ports, 1 if body.show_in_legend else 0, mapping_id),
            )
            await db.commit()
            async with db.execute(
                "SELECT * FROM nat_mappings WHERE id = ?", (mapping_id,)
            ) as cur:
                row = await cur.fetchone()
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return dict(row)


@router.post("/reorder", response_model=list[NatMapping])
async def reorder_nat_mappings(_: AdminUser, body: ReorderIn):
    """Persist a drag-and-drop reorder (admin only) — rewrites priority 0..N-1
    to match the given id order. Must include every existing mapping's id."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if await _isp_dhcp_enabled(db):
            raise HTTPException(status_code=400, detail="NAT mappings are locked while ISP DHCP mode is enabled")
        async with db.execute("SELECT id FROM nat_mappings") as cur:
            existing_ids = {r["id"] for r in await cur.fetchall()}
        if set(body.ids) != existing_ids:
            raise HTTPException(status_code=400, detail="ids must match the full current set of NAT mappings")
        try:
            for index, mapping_id in enumerate(body.ids):
                await db.execute(
                    "UPDATE nat_mappings SET priority = ? WHERE id = ?", (index, mapping_id)
                )
            await db.commit()
            async with db.execute(
                "SELECT * FROM nat_mappings ORDER BY priority, id"
            ) as cur:
                rows = await cur.fetchall()
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return [dict(r) for r in rows]


@router.delete("/{mapping_id}", status_code=204)
async def delete_nat_mapping(_: AdminUser, mapping_id: int):
    """Delete a NAT mapping (admin only)."""
    async with aiosqlite.connect(DB_PATH) as db:
        if await _isp_dhcp_enabled(db):
            raise HTTPException(status_code=400, detail="NAT mappings are locked while ISP DHCP mode is enabled")
        async with db.execute(
            "SELECT id FROM nat_mappings WHERE id = ?", (mapping_id,)
        ) as cur:
            if not await cur.fetchone():
                raise HTTPException(status_code=404, detail="Mapping not found")
        await db.execute("DELETE FROM nat_mappings WHERE id = ?", (mapping_id,))
        await db.commit()
    return None
