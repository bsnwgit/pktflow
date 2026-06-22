"""
POST /api/ai/chat — Claude AI assistant endpoint.
Sends current flow context + user question to the Anthropic API.
Requires a valid API key in settings (anthropic_api_key).
"""
from __future__ import annotations

import json
import logging
from typing import Any

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.database import get_db
from app.dependencies import CurrentUser

router = APIRouter()
log = logging.getLogger("pktflow.ai")

SYSTEM_PROMPT = """You are a network operations assistant integrated into pktFlow, a NetFlow
visualization platform. Your role is to help network engineers interpret traffic data,
diagnose anomalies, answer networking questions, and provide actionable recommendations.

You will receive structured NetFlow context (device summaries, top talkers, recent stats)
alongside the user's question. Analyze the data and provide clear, concise answers.

Guidelines:
- Be specific and reference the actual data provided when relevant
- Flag anomalies, unusual traffic patterns, or potential issues you notice
- Suggest investigation steps when appropriate
- Keep responses focused — users are busy network engineers
- Use plain text; avoid markdown headers in responses (inline bold is fine)"""


class ChatRequest(BaseModel):
    question: str
    context: dict[str, Any] = {}  # Flow data from the current view passed by the frontend


class ChatResponse(BaseModel):
    answer: str
    tokens_used: int = 0


async def _get_setting(db: aiosqlite.Connection, key: str) -> Any:
    async with db.execute("SELECT value FROM settings WHERE key=?", (key,)) as cur:
        row = await cur.fetchone()
    return json.loads(row[0]) if row else None


@router.post("/chat", response_model=ChatResponse)
async def chat(
    body: ChatRequest,
    _: CurrentUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Send a question + flow context to Claude and stream back the answer."""
    api_key = await _get_setting(db, "anthropic_api_key")
    if not api_key or api_key == "••••••••":
        raise HTTPException(
            status_code=503,
            detail="AI assistant not configured. Add your Anthropic API key in Settings → General.",
        )

    # Build context block
    ctx_lines: list[str] = []
    if body.context.get("devices"):
        ctx_lines.append("=== Active Devices ===")
        for d in body.context["devices"][:10]:
            ctx_lines.append(
                f"  {d.get('sampler_name') or d.get('sampler_ip')} ({d.get('site','')}): "
                f"{d.get('flows_per_sec', 0):.1f} fps, "
                f"{_fmt_bytes(d.get('bytes_last_hour', 0))} last hour"
            )
    if body.context.get("top_talkers"):
        ctx_lines.append("\n=== Top Talkers (last hour) ===")
        for t in body.context["top_talkers"][:10]:
            ctx_lines.append(
                f"  {t.get('src_ip')} → {t.get('dst_ip')}:{t.get('dst_port')} "
                f"proto={t.get('protocol')} bytes={_fmt_bytes(t.get('bytes', 0))}"
            )
    if body.context.get("flow_rate"):
        ctx_lines.append(f"\n=== Current Rate ===\n  {body.context['flow_rate']:.1f} flows/sec")
    if body.context.get("extra"):
        ctx_lines.append(f"\n=== Additional Context ===\n{body.context['extra']}")

    context_str = "\n".join(ctx_lines) if ctx_lines else "(No flow context provided)"
    user_message = f"Network Flow Data:\n{context_str}\n\nQuestion: {body.question}"

    try:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=api_key)
        response = await client.messages.create(
            model="claude-haiku-4-5-20251001",   # Fast + cost-effective for in-app assistant
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )
        answer = response.content[0].text
        tokens = response.usage.input_tokens + response.usage.output_tokens
        return ChatResponse(answer=answer, tokens_used=tokens)

    except Exception as e:
        log.error(f"AI chat error: {e}")
        if "authentication" in str(e).lower() or "api_key" in str(e).lower():
            raise HTTPException(status_code=503, detail="Invalid Anthropic API key. Check Settings → General.")
        raise HTTPException(status_code=502, detail=f"AI service error: {str(e)[:200]}")


def _fmt_bytes(b: int) -> str:
    if b >= 1e9: return f"{b/1e9:.1f}GB"
    if b >= 1e6: return f"{b/1e6:.1f}MB"
    if b >= 1e3: return f"{b/1e3:.1f}KB"
    return f"{b}B"
