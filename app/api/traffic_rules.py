"""
Traffic Rules — CRUD endpoints.

The single source of visual styling on the Geo Map — Address Mappings
resolve location only, never a line style. A rule matches on an address
mapping (None = any), a list of destination CIDRs/IPs, and/or a list of
destination ports (or port ranges); at least one of the three is required.
dst_cidrs and dst_ports are comma-separated (e.g. "1.1.1.1,9.9.9.9" or
"53,8000-9000") — a rule matches if the destination falls in ANY listed CIDR
and/or ANY listed port/range. A rule with only an address mapping set (no
destination filter) acts as that mapping's default/catch-all style, so e.g.
"any of Site A's traffic" gets one line while "Site A's traffic to 1.1.1.1
or 9.9.9.9" or "any traffic to port 53" can be pulled out with a more
specific rule above it — matching is first-hit in priority order, top to
bottom, so a catch-all rule must be placed below anything more specific for
the same mapping or it will shadow it.

`priority` (lower wins) resolves conflicts when more than one rule matches
the same flow. It is never set directly by the client — new rows are
appended to the end, and reordering happens via POST /reorder.

All users can list rules (GET).
Only admins can create, update, delete, or reorder (POST, PUT, DELETE).
"""
from __future__ import annotations

import ipaddress

import aiosqlite
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator, model_validator
from typing import Optional

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


class TrafficRuleIn(BaseModel):
    name:               str
    address_mapping_id: Optional[int] = None
    dst_cidrs:          Optional[str] = None  # comma-separated IPs/CIDRs, e.g. "1.1.1.1,9.9.9.9"
    dst_ports:          Optional[str] = None  # comma-separated ports/ranges, e.g. "53,8000-9000"
    line_style_id:      Optional[int] = None

    @field_validator("dst_cidrs")
    @classmethod
    def _check_cidrs(cls, v: Optional[str]) -> Optional[str]:
        return _validate_cidrs(v) if v else v

    @field_validator("dst_ports")
    @classmethod
    def _check_ports(cls, v: Optional[str]) -> Optional[str]:
        return _validate_ports(v) if v else v

    @model_validator(mode="after")
    def _require_a_match_condition(self):
        if self.address_mapping_id is None and not self.dst_cidrs and not self.dst_ports:
            raise ValueError("At least one of Address Mapping, Destination IPs/CIDRs, or Destination Ports is required")
        return self


class TrafficRule(TrafficRuleIn):
    id:         int
    priority:   int
    created_at: str


class ReorderIn(BaseModel):
    ids: list[int]  # full ordered list of traffic_rules.id, first = highest priority


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/", response_model=list[TrafficRule])
async def list_traffic_rules(_: CurrentUser):
    """Return all traffic rules ordered by priority (highest first)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM traffic_rules ORDER BY priority, id") as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/", response_model=TrafficRule, status_code=201)
async def create_traffic_rule(_: AdminUser, body: TrafficRuleIn):
    """Add a new traffic rule (admin only). Appended at the end of priority order."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        try:
            async with db.execute("SELECT COALESCE(MAX(priority) + 1, 0) FROM traffic_rules") as cur:
                next_priority = (await cur.fetchone())[0]
            cur = await db.execute(
                """INSERT INTO traffic_rules
                   (name, address_mapping_id, dst_cidrs, dst_ports, line_style_id, priority)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (body.name, body.address_mapping_id, body.dst_cidrs,
                 body.dst_ports, body.line_style_id, next_priority),
            )
            await db.commit()
            async with db.execute(
                "SELECT * FROM traffic_rules WHERE id = ?", (cur.lastrowid,)
            ) as cur2:
                row = await cur2.fetchone()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return dict(row)


@router.put("/{rule_id}", response_model=TrafficRule)
async def update_traffic_rule(_: AdminUser, rule_id: int, body: TrafficRuleIn):
    """Update an existing traffic rule (admin only). Priority is untouched — use /reorder."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id FROM traffic_rules WHERE id = ?", (rule_id,)
        ) as cur:
            if not await cur.fetchone():
                raise HTTPException(status_code=404, detail="Rule not found")
        try:
            await db.execute(
                """UPDATE traffic_rules
                   SET name=?, address_mapping_id=?, dst_cidrs=?, dst_ports=?, line_style_id=?
                   WHERE id=?""",
                (body.name, body.address_mapping_id, body.dst_cidrs,
                 body.dst_ports, body.line_style_id, rule_id),
            )
            await db.commit()
            async with db.execute(
                "SELECT * FROM traffic_rules WHERE id = ?", (rule_id,)
            ) as cur:
                row = await cur.fetchone()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return dict(row)


@router.post("/reorder", response_model=list[TrafficRule])
async def reorder_traffic_rules(_: AdminUser, body: ReorderIn):
    """Persist a drag-and-drop reorder (admin only) — rewrites priority 0..N-1
    to match the given id order. Must include every existing rule's id."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT id FROM traffic_rules") as cur:
            existing_ids = {r["id"] for r in await cur.fetchall()}
        if set(body.ids) != existing_ids:
            raise HTTPException(status_code=400, detail="ids must match the full current set of traffic rules")
        try:
            for index, rule_id in enumerate(body.ids):
                await db.execute(
                    "UPDATE traffic_rules SET priority = ? WHERE id = ?", (index, rule_id)
                )
            await db.commit()
            async with db.execute(
                "SELECT * FROM traffic_rules ORDER BY priority, id"
            ) as cur:
                rows = await cur.fetchall()
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    return [dict(r) for r in rows]


@router.delete("/{rule_id}", status_code=204)
async def delete_traffic_rule(_: AdminUser, rule_id: int):
    """Delete a traffic rule (admin only)."""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id FROM traffic_rules WHERE id = ?", (rule_id,)
        ) as cur:
            if not await cur.fetchone():
                raise HTTPException(status_code=404, detail="Rule not found")
        await db.execute("DELETE FROM traffic_rules WHERE id = ?", (rule_id,))
        await db.commit()
    return None
