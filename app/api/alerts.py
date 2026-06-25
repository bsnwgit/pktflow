"""
CRUD /api/alerts/* — alert rules and alert event history.
"""
from __future__ import annotations

import json
from typing import Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.database import get_db
from app.dependencies import CurrentUser, AnalystUser, AdminUser

router = APIRouter()


class AlertRuleIn(BaseModel):
    name: str
    description: str = ""
    enabled: bool = True
    rule_type: str   # threshold | rate_spike | port_protocol | new_host | data_gap
    conditions: dict = {}
    time_window_min: int = 5
    severity: str = "warning"
    channels: list[str] = ["inapp"]
    cooldown_min: int = 30


# ── Rules ─────────────────────────────────────────────────────────────────────

@router.get("/rules")
async def list_rules(_: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute("SELECT * FROM alert_rules ORDER BY severity DESC, name") as cur:
        rows = await cur.fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["conditions"] = json.loads(d["conditions"])
        d["channels"] = json.loads(d["channels"])
        result.append(d)
    return result


@router.post("/rules", status_code=status.HTTP_201_CREATED)
async def create_rule(body: AlertRuleIn, user: AnalystUser, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute(
        """INSERT INTO alert_rules
           (name, description, enabled, rule_type, conditions, time_window_min,
            severity, channels, cooldown_min, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *""",
        (body.name, body.description, int(body.enabled), body.rule_type,
         json.dumps(body.conditions), body.time_window_min,
         body.severity, json.dumps(body.channels), body.cooldown_min, user["id"]),
    ) as cur:
        row = await cur.fetchone()
    await db.commit()
    d = dict(row)
    d["conditions"] = json.loads(d["conditions"])
    d["channels"] = json.loads(d["channels"])
    return d


@router.put("/rules/{rule_id}")
async def update_rule(
    rule_id: int,
    body: AlertRuleIn,
    _: AnalystUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    await db.execute(
        """UPDATE alert_rules
           SET name=?, description=?, enabled=?, rule_type=?, conditions=?,
               time_window_min=?, severity=?, channels=?, cooldown_min=?,
               updated_at=datetime('now')
           WHERE id=?""",
        (body.name, body.description, int(body.enabled), body.rule_type,
         json.dumps(body.conditions), body.time_window_min,
         body.severity, json.dumps(body.channels), body.cooldown_min, rule_id),
    )
    await db.commit()
    return {"updated": True}


@router.patch("/rules/{rule_id}/toggle")
async def toggle_rule(rule_id: int, _: AnalystUser, db: aiosqlite.Connection = Depends(get_db)):
    await db.execute(
        "UPDATE alert_rules SET enabled = NOT enabled WHERE id = ?", (rule_id,)
    )
    await db.commit()
    return {"toggled": True}


@router.delete("/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule(rule_id: int, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    # Cascade: notification_log → alert_events → alert_rules (FK chain, foreign_keys=ON)
    await db.execute(
        "DELETE FROM notification_log WHERE event_id IN (SELECT id FROM alert_events WHERE rule_id = ?)",
        (rule_id,),
    )
    await db.execute("DELETE FROM alert_events WHERE rule_id = ?", (rule_id,))
    await db.execute("DELETE FROM alert_rules WHERE id = ?", (rule_id,))
    await db.commit()


# ── Events ────────────────────────────────────────────────────────────────────

@router.get("/events")
async def list_events(
    _: CurrentUser,
    limit: int = 100,
    unacked_only: bool = False,
    db: aiosqlite.Connection = Depends(get_db),
):
    # unacked_only=True  → active tab: not yet user-acked (includes auto-resolved)
    # unacked_only=False → full history
    where = "WHERE ae.acked_at IS NULL" if unacked_only else ""
    async with db.execute(f"""
        SELECT ae.id, ae.rule_id, ae.severity, ae.message, ae.details,
               ae.fired_at, ae.acked_at, ae.acked_by,
               ae.resolved_at, ae.auto_resolved,
               ar.name AS rule_name, ar.severity AS rule_severity
        FROM alert_events ae
        JOIN alert_rules ar ON ae.rule_id = ar.id
        {where}
        ORDER BY ae.fired_at DESC
        LIMIT ?
    """, (limit,)) as cur:
        rows = await cur.fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["details"] = json.loads(d["details"])
        # Normalise: rule_severity shadows severity from the join — use ae.severity
        result.append(d)
    return result


@router.post("/events/{event_id}/ack")
async def ack_event(event_id: int, user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    """User-initiated acknowledge — clears the event from the active view."""
    await db.execute(
        "UPDATE alert_events SET acked_at=datetime('now'), acked_by=? WHERE id=?",
        (user["id"], event_id),
    )
    await db.commit()
    return {"acked": True}


@router.post("/events/ack-all")
async def ack_all_events(user: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    """Acknowledge all unacked events (active + auto-resolved)."""
    await db.execute(
        "UPDATE alert_events SET acked_at=datetime('now'), acked_by=? WHERE acked_at IS NULL",
        (user["id"],),
    )
    await db.commit()
    return {"acked": True}
