"""
CRUD /api/alerts/* — alert rules and alert event history.
"""
from __future__ import annotations

import json
from typing import Optional

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from pydantic import BaseModel

from app.database import get_db
from app.dependencies import CurrentUser, AnalystUser, AdminUser

router = APIRouter()


class AlertRuleIn(BaseModel):
    name: str
    description: str = ""
    enabled: bool = True
    rule_type: str   # see CHECK constraint on alert_rules.rule_type (migrations/027) for the full list
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


@router.get("/rules/export")
async def export_rules(_: CurrentUser, db: aiosqlite.Connection = Depends(get_db)):
    """Export all alert rules as a CSV file download."""
    import csv
    import io
    from fastapi.responses import StreamingResponse

    db.row_factory = aiosqlite.Row
    async with db.execute(
        """SELECT name, description, rule_type, conditions, time_window_min,
                  severity, channels, cooldown_min, enabled
           FROM alert_rules ORDER BY id"""
    ) as cur:
        rows = await cur.fetchall()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "name", "description", "rule_type", "conditions", "time_window_min",
        "severity", "channels", "cooldown_min", "enabled",
    ])
    for r in rows:
        try:
            channels = ",".join(json.loads(r["channels"]))
        except Exception:
            channels = "inapp"
        writer.writerow([
            r["name"], r["description"] or "", r["rule_type"],
            r["conditions"] or "{}", r["time_window_min"],
            r["severity"], channels, r["cooldown_min"],
            "true" if r["enabled"] else "false",
        ])
    buf.seek(0)
    return StreamingResponse(
        io.BytesIO(buf.getvalue().encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="pktflow-alert-rules.csv"'},
    )


@router.post("/rules/import-csv")
async def import_rules_csv(
    file: UploadFile,
    user: AnalystUser,
    db: aiosqlite.Connection = Depends(get_db),
) -> dict:
    """Import alert rules from a multipart CSV upload.

    CSV columns (header row required):
      name, description, rule_type, conditions, time_window_min, severity,
      channels, cooldown_min, enabled

    - rule_type: see CHECK constraint on alert_rules.rule_type (migrations/027) for the full list
    - conditions: a JSON object string, e.g. '{"bytes_threshold": 1000000}' —
      the exact shape depends on rule_type, same as what the UI builds.
      Blank or invalid JSON is treated as {}.
    - channels: comma-separated, e.g. "inapp,slack". Blank defaults to "inapp".
    - Rows are always inserted as new rules (no de-dup by name).
    """
    import csv, io

    raw = await file.read()
    text = raw.decode("utf-8-sig")  # strip BOM (Excel exports)

    reader = csv.DictReader(io.StringIO(text))
    created = 0
    skipped = 0
    errors: list[str] = []

    for lineno, row in enumerate(reader, start=2):
        name = (row.get("name") or "").strip()
        rule_type = (row.get("rule_type") or "").strip()
        if not name or not rule_type:
            errors.append(f"Row {lineno}: missing name or rule_type — skipped")
            skipped += 1
            continue

        conditions_raw = (row.get("conditions") or "").strip()
        try:
            conditions = json.loads(conditions_raw) if conditions_raw else {}
            if not isinstance(conditions, dict):
                raise ValueError("conditions must be a JSON object")
        except Exception as exc:
            errors.append(f"Row {lineno}: {name}: invalid conditions JSON ({exc}) — skipped")
            skipped += 1
            continue

        channels_raw = (row.get("channels") or "inapp").strip()
        channels = [c.strip() for c in channels_raw.split(",") if c.strip()] or ["inapp"]

        time_window_str = (row.get("time_window_min") or "5").strip()
        time_window_min = int(time_window_str) if time_window_str.lstrip("-").isdigit() else 5

        cooldown_str = (row.get("cooldown_min") or "30").strip()
        cooldown_min = int(cooldown_str) if cooldown_str.lstrip("-").isdigit() else 30

        enabled_str = (row.get("enabled") or "true").strip().lower()
        enabled = enabled_str not in ("false", "0", "no")

        try:
            await db.execute(
                """INSERT INTO alert_rules
                    (name, description, enabled, rule_type, conditions, time_window_min,
                     severity, channels, cooldown_min, created_by)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (
                    name, (row.get("description") or "").strip(), int(enabled), rule_type,
                    json.dumps(conditions), time_window_min,
                    (row.get("severity") or "warning").strip(), json.dumps(channels),
                    cooldown_min, user["id"],
                ),
            )
            created += 1
        except Exception as exc:
            errors.append(f"Row {lineno}: {name}: {exc}")
            skipped += 1

    await db.commit()
    return {"created": created, "skipped": skipped, "errors": errors}


# ── Events ────────────────────────────────────────────────────────────────────

@router.get("/events")
async def list_events(
    _: CurrentUser,
    limit: int = 100,
    unacked_only: bool = False,
    since: Optional[str] = None,
    until: Optional[str] = None,
    db: aiosqlite.Connection = Depends(get_db),
):
    # unacked_only=True  → active tab: not yet user-acked (includes auto-resolved)
    # unacked_only=False → full history
    clauses = []
    params: list = []
    if unacked_only:
        clauses.append("ae.acked_at IS NULL")
    if since:
        # fired_at is stored via SQLite's own datetime('now') (space-separated,
        # no 'Z'/fractional seconds) — wrap the incoming ISO string in datetime()
        # too so the comparison is format-normalized on both sides.
        clauses.append("ae.fired_at >= datetime(?)")
        params.append(since)
    if until:
        clauses.append("ae.fired_at <= datetime(?)")
        params.append(until)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(limit)
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
    """, params) as cur:
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
