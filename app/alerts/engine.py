"""
Alert engine — runs on a schedule, evaluates all enabled alert rules,
fires AlertEvents, and dispatches notifications.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

import aiosqlite

from app.config import get_settings

log = logging.getLogger("pktflow.alerts")
settings = get_settings()

_unknown_sampler_queue: list[str] = []


class AlertEngine:
    _instance: "Optional[AlertEngine]" = None

    def __init__(self, interval_seconds: int = 60):
        self._interval = interval_seconds
        self._task: Optional[asyncio.Task] = None

    async def start(self) -> None:
        AlertEngine._instance = self
        self._task = asyncio.create_task(self._run_loop())
        log.info(f"Alert engine started (interval={self._interval}s)")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run_loop(self) -> None:
        while True:
            try:
                await self._evaluate_all()
            except Exception as e:
                log.error(f"Alert engine evaluation error: {e}")
            await asyncio.sleep(self._interval)

    async def _evaluate_all(self) -> None:
        async with aiosqlite.connect(settings.db_path) as db:
            db.row_factory = aiosqlite.Row
            # Fetch enabled rules
            async with db.execute(
                "SELECT * FROM alert_rules WHERE enabled = 1"
            ) as cur:
                rules = [dict(r) for r in await cur.fetchall()]

            for rule in rules:
                try:
                    rule["conditions"] = json.loads(rule["conditions"])
                    rule["channels"] = json.loads(rule["channels"])
                    await self._evaluate_rule(db, rule)
                except Exception as e:
                    log.warning(f"Error evaluating rule '{rule['name']}': {e}")

            # Process unknown sampler queue
            await self._check_unknown_samplers(db)

    async def _evaluate_rule(self, db: aiosqlite.Connection, rule: dict) -> None:
        from app.storage.factory import get_storage

        rule_type = rule["rule_type"]
        fired_message: Optional[str] = None
        details: dict = {}

        if rule_type == "data_gap":
            silence_min = rule["conditions"].get("silence_minutes", 10)
            last_seen = await get_storage().get_sampler_last_seen()
            now = datetime.now(tz=timezone.utc)

            # Fire for any sampler that has gone silent
            gapped_samplers: set[str] = set()
            for sampler_ip, ts in last_seen.items():
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                if (now - ts) > timedelta(minutes=silence_min):
                    gapped_samplers.add(sampler_ip)
                    fired_message = f"No flows from {sampler_ip} for >{silence_min} minutes (last seen: {ts.isoformat()})"
                    details = {"sampler_ip": sampler_ip, "last_seen": ts.isoformat()}
                    await self._fire(db, rule, fired_message, details)

            # Auto-resolve open events whose sampler has recovered
            await self._auto_resolve_data_gap(db, rule, gapped_samplers, last_seen, silence_min)
            return  # handled per-sampler above

        elif rule_type == "new_host":
            return  # handled via notify_unknown_sampler()

        elif rule_type == "threshold":
            await self._evaluate_threshold(db, rule)

        elif rule_type == "rate_spike":
            await self._evaluate_rate_spike(db, rule)

        elif rule_type == "port_protocol":
            await self._evaluate_port_protocol(db, rule)

    async def _evaluate_threshold(self, db: aiosqlite.Connection, rule: dict) -> None:
        from app.storage.factory import get_storage
        conds = rule["conditions"]
        metric = conds.get("metric", "bytes")
        operator = conds.get("operator", "gt")
        threshold = float(conds.get("value", 0))
        sampler_ip = conds.get("sampler_ip") or None
        window_min = rule.get("time_window_min", 5)

        current = await get_storage().get_metric_in_window(metric, window_min, sampler_ip)
        ops = {"gt": current > threshold, "gte": current >= threshold,
               "lt": current < threshold, "lte": current <= threshold}
        if ops.get(operator, False):
            op_sym = {"gt": ">", "gte": "≥", "lt": "<", "lte": "≤"}.get(operator, operator)
            sampler_str = f" from {sampler_ip}" if sampler_ip else ""
            await self._fire(db, rule, (
                f"Threshold breached{sampler_str}: {metric} in last {window_min}m "
                f"= {current:,.0f} {op_sym} {threshold:,.0f}"
            ), {"metric": metric, "current": current, "threshold": threshold,
                "operator": operator, "sampler_ip": sampler_ip or "all"})
        else:
            await self._auto_resolve(db, rule, f"{metric} back within threshold (current: {current:,.0f})")

    async def _evaluate_rate_spike(self, db: aiosqlite.Connection, rule: dict) -> None:
        from app.storage.factory import get_storage
        conds = rule["conditions"]
        metric = conds.get("metric", "bytes")
        multiplier = float(conds.get("multiplier", 3.0))
        baseline_days = int(conds.get("baseline_days", 7))
        sampler_ip = conds.get("sampler_ip") or None
        window_min = rule.get("time_window_min", 5)

        storage = get_storage()
        current = await storage.get_metric_in_window(metric, window_min, sampler_ip)
        baseline = await storage.get_metric_baseline(metric, baseline_days, window_min, sampler_ip)

        if baseline > 0 and current >= baseline * multiplier:
            ratio = current / baseline
            sampler_str = f" from {sampler_ip}" if sampler_ip else ""
            await self._fire(db, rule, (
                f"Rate spike detected{sampler_str}: {metric} in last {window_min}m "
                f"= {current:,.0f} ({ratio:.1f}× the {baseline_days}-day baseline of {baseline:,.0f})"
            ), {"metric": metric, "current": current, "baseline": baseline,
                "ratio": round(ratio, 2), "multiplier": multiplier,
                "sampler_ip": sampler_ip or "all"})
        else:
            await self._auto_resolve(db, rule, f"{metric} rate back to normal (current: {current:,.0f}, baseline: {baseline:,.0f})")

    async def _evaluate_port_protocol(self, db: aiosqlite.Connection, rule: dict) -> None:
        from app.storage.factory import get_storage
        conds = rule["conditions"]
        port = int(conds.get("port", 0))
        if port <= 0:
            log.warning(f"port_protocol rule '{rule['name']}' has no valid port configured")
            return
        proto_str = conds.get("protocol", "any")
        direction = conds.get("direction", "any")
        sampler_ip = conds.get("sampler_ip") or None
        window_min = rule.get("time_window_min", 5)

        _PROTO_INT = {"TCP": 6, "UDP": 17}
        protocol_int = _PROTO_INT.get(proto_str) if proto_str != "any" else None

        count = await get_storage().get_port_flow_count(port, protocol_int, direction, window_min, sampler_ip)
        if count > 0:
            dir_str = {"src": "src port", "dst": "dst port", "any": "port"}.get(direction, "port")
            proto_label = proto_str if proto_str != "any" else "any protocol"
            sampler_str = f" on {sampler_ip}" if sampler_ip else ""
            await self._fire(db, rule, (
                f"Traffic on {dir_str} {port}/{proto_label}{sampler_str}: "
                f"{count} flows in last {window_min}m"
            ), {"port": port, "protocol": proto_str, "direction": direction,
                "flow_count": count, "sampler_ip": sampler_ip or "all"})
        else:
            await self._auto_resolve(db, rule, f"No traffic on port {port}/{proto_str} in last {window_min}m")

    async def _auto_resolve(self, db: aiosqlite.Connection, rule: dict, reason: str) -> None:
        """Mark open events for this rule as auto-resolved when the condition has cleared."""
        async with db.execute(
            "SELECT id FROM alert_events WHERE rule_id = ? AND acked_at IS NULL AND resolved_at IS NULL",
            (rule["id"],),
        ) as cur:
            open_ids = [r[0] for r in await cur.fetchall()]
        if not open_ids:
            return
        for eid in open_ids:
            await db.execute(
                "UPDATE alert_events SET resolved_at = datetime('now'), auto_resolved = 1 WHERE id = ?",
                (eid,),
            )
        await db.commit()
        log.info(
            f"Auto-resolved {len(open_ids)} event(s) for rule '{rule['name']}': {reason}"
        )

    async def _auto_resolve_data_gap(
        self,
        db: aiosqlite.Connection,
        rule: dict,
        gapped_samplers: set,
        last_seen: dict,
        silence_min: int,
    ) -> None:
        """Auto-resolve data_gap events whose sampler has recovered."""
        async with db.execute(
            "SELECT id, details FROM alert_events WHERE rule_id = ? AND acked_at IS NULL AND resolved_at IS NULL",
            (rule["id"],),
        ) as cur:
            open_events = [(r[0], json.loads(r[1])) for r in await cur.fetchall()]
        if not open_events:
            return
        now = datetime.now(tz=timezone.utc)
        for eid, details in open_events:
            sampler_ip = details.get("sampler_ip", "")
            if sampler_ip in gapped_samplers:
                continue  # still gapped — don't resolve
            ts = last_seen.get(sampler_ip)
            if ts is None:
                continue  # no data at all — can't confirm recovery
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if (now - ts) <= timedelta(minutes=silence_min):
                await db.execute(
                    "UPDATE alert_events SET resolved_at = datetime('now'), auto_resolved = 1 WHERE id = ?",
                    (eid,),
                )
                log.info(
                    f"Auto-resolved data_gap event {eid} for rule '{rule['name']}': "
                    f"{sampler_ip} recovered (last seen {ts.isoformat()})"
                )
        await db.commit()

    async def _fire(self, db: aiosqlite.Connection, rule: dict, message: str, details: dict) -> None:
        """Record an alert event and dispatch notifications, respecting cooldown."""
        # Check cooldown
        if rule.get("last_fired"):
            last = datetime.fromisoformat(rule["last_fired"])
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            if (datetime.now(tz=timezone.utc) - last) < timedelta(minutes=rule["cooldown_min"]):
                return  # Still in cooldown

        # Record event
        async with db.execute(
            "INSERT INTO alert_events (rule_id, severity, message, details) VALUES (?,?,?,?) RETURNING id",
            (rule["id"], rule["severity"], message, json.dumps(details)),
        ) as cur:
            row = await cur.fetchone()
            event_id = row[0]

        # Update last_fired timestamp
        await db.execute(
            "UPDATE alert_rules SET last_fired = datetime('now') WHERE id = ?", (rule["id"],)
        )
        await db.commit()

        log.warning(f"ALERT [{rule['severity'].upper()}] {rule['name']}: {message}")

        # Dispatch to notification channels
        for channel in rule.get("channels", ["inapp"]):
            await self._dispatch(db, event_id, channel, rule["name"], message, rule["severity"])

    async def _dispatch(
        self, db: aiosqlite.Connection, event_id: int,
        channel: str, rule_name: str, message: str, severity: str,
    ) -> None:
        """Send notification to a channel, log the result."""
        try:
            if channel == "inapp":
                status = "sent"  # In-app is the alert_events table itself
            elif channel == "slack":
                status = await self._send_slack(db, rule_name, message, severity)
            elif channel == "email":
                status = await self._send_email(db, rule_name, message, severity)
            elif channel == "pagerduty":
                status = await self._send_pagerduty(db, rule_name, message, severity)
            elif channel == "webhook":
                status = await self._send_webhook(db, rule_name, message, severity)
            else:
                status = "skipped"
        except Exception as e:
            log.error(f"Notification dispatch error ({channel}): {e}")
            status = "failed"

        await db.execute(
            "INSERT INTO notification_log (event_id, channel, status) VALUES (?,?,?)",
            (event_id, channel, status),
        )
        await db.commit()

    async def _send_slack(self, db, rule_name, message, severity) -> str:
        async with db.execute("SELECT value FROM settings WHERE key='notify_slack_webhook_url'") as cur:
            row = await cur.fetchone()
        if not row:
            return "skipped"
        import httpx
        url = json.loads(row[0])
        emoji = {"critical": ":red_circle:", "warning": ":large_yellow_circle:"}.get(severity, ":white_circle:")
        payload = {"text": f"{emoji} *pktFlow Alert — {rule_name}*\n{message}"}
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, timeout=5)
        return "sent" if resp.status_code == 200 else "failed"

    async def _send_email(self, db, rule_name, message, severity) -> str:
        async def _get(key):
            async with db.execute("SELECT value FROM settings WHERE key=?", (key,)) as c:
                row = await c.fetchone()
            return json.loads(row[0]) if row else None

        if not await _get("notify_email_enabled"):
            return "skipped"

        host      = await _get("notify_email_smtp_host")   or ""
        port      = await _get("notify_email_smtp_port")   or 587
        tls_val   = await _get("notify_email_smtp_tls")
        use_tls   = tls_val if tls_val is not None else True
        username  = await _get("notify_email_username")    or ""
        password  = await _get("notify_email_password")    or ""
        from_addr = await _get("notify_email_from")        or "pktflow@localhost"
        to_addrs  = await _get("notify_email_default_to")  or []

        if not host or not to_addrs:
            return "skipped"

        try:
            import aiosmtplib
            from email.mime.text import MIMEText
            from email.mime.multipart import MIMEMultipart

            sev_upper = severity.upper()
            msg = MIMEMultipart("alternative")
            msg["Subject"] = f"[pktFlow {sev_upper}] {rule_name}"
            msg["From"] = from_addr
            msg["To"] = ", ".join(to_addrs)
            body = f"pktFlow Alert\n\nRule: {rule_name}\nSeverity: {sev_upper}\n\n{message}"
            msg.attach(MIMEText(body, "plain"))

            await aiosmtplib.send(
                msg,
                hostname=host,
                port=int(port),
                use_tls=bool(use_tls),
                username=username or None,
                password=password or None,
            )
            return "sent"
        except Exception as e:
            log.error(f"Email send error: {e}")
            return "failed"

    async def _send_pagerduty(self, db, rule_name, message, severity) -> str:
        async def _get(key):
            async with db.execute("SELECT value FROM settings WHERE key=?", (key,)) as c:
                row = await c.fetchone()
            return json.loads(row[0]) if row else None

        if not await _get("notify_pagerduty_enabled"):
            return "skipped"

        key = await _get("notify_pagerduty_integration_key") or ""
        if not key:
            return "skipped"

        sev_map = {"critical": "critical", "warning": "warning", "info": "info"}
        payload = {
            "routing_key": key,
            "event_action": "trigger",
            "payload": {
                "summary": f"[pktFlow] {rule_name}: {message}",
                "severity": sev_map.get(severity, "warning"),
                "source": "pktflow",
            },
        }

        try:
            import httpx
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    "https://events.pagerduty.com/v2/enqueue",
                    json=payload,
                    timeout=10,
                )
            return "sent" if resp.status_code in (200, 202) else "failed"
        except Exception as e:
            log.error(f"PagerDuty send error: {e}")
            return "failed"

    async def _send_webhook(self, db, rule_name, message, severity) -> str:
        async def _get(key):
            async with db.execute("SELECT value FROM settings WHERE key=?", (key,)) as c:
                row = await c.fetchone()
            return json.loads(row[0]) if row else None

        if not await _get("notify_webhook_enabled"):
            return "skipped"

        url      = await _get("notify_webhook_url")             or ""
        method   = await _get("notify_webhook_method")          or "POST"
        template = await _get("notify_webhook_payload_template") or ""
        headers_cfg = await _get("notify_webhook_headers")      or {}

        if not url:
            return "skipped"

        try:
            from jinja2 import Template
            now = datetime.now(tz=timezone.utc).isoformat()
            rendered = Template(template).render(
                alert_name=rule_name,
                message=message,
                severity=severity,
                fired_at=now,
            )
            body = json.loads(rendered)
        except Exception as e:
            log.error(f"Webhook template render error: {e}")
            return "failed"

        try:
            import httpx
            async with httpx.AsyncClient() as client:
                resp = await client.request(
                    method.upper(), url,
                    json=body,
                    headers=headers_cfg,
                    timeout=10,
                )
            return "sent" if resp.status_code < 300 else "failed"
        except Exception as e:
            log.error(f"Webhook send error: {e}")
            return "failed"

    async def _check_unknown_samplers(self, db: aiosqlite.Connection) -> None:
        global _unknown_sampler_queue
        if not _unknown_sampler_queue:
            return
        ips = list(set(_unknown_sampler_queue))
        _unknown_sampler_queue.clear()

        # Check which are actually not in the device registry
        for ip in ips:
            async with db.execute("SELECT 1 FROM devices WHERE ip = ?", (ip,)) as cur:
                exists = await cur.fetchone()
            if not exists:
                async with db.execute(
                    "SELECT * FROM alert_rules WHERE rule_type='new_host' AND enabled=1"
                ) as cur:
                    rule = await cur.fetchone()
                if rule:
                    rule_dict = dict(rule)
                    rule_dict["conditions"] = json.loads(rule_dict["conditions"])
                    rule_dict["channels"] = json.loads(rule_dict["channels"])
                    await self._fire(
                        db, rule_dict,
                        f"Unknown sampler {ip} sent NetFlow data — not in device registry",
                        {"sampler_ip": ip},
                    )

    @staticmethod
    def notify_unknown_sampler(ip: str) -> None:
        """Called from ingest handler when an unrecognized source sends data."""
        _unknown_sampler_queue.append(ip)
