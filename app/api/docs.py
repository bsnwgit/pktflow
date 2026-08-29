"""
In-app documentation — serves the markdown files under docs/ so they can be
read from the UI instead of only from a repo checkout.
"""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import get_current_user

router = APIRouter()


def _docs_dir() -> Path:
    # pktFlow's Settings model has no install_dir field (unlike the other
    # pkt* apps) — resolve relative to this file instead, matching how
    # app/main.py locates frontend/dist and pktflow.db.
    return Path(__file__).parent.parent.parent / "docs"


def _title_from_filename(filename: str) -> str:
    stem = Path(filename).stem
    words = re.split(r"[-_]+", stem)
    return " ".join(w if w.isupper() and len(w) <= 3 else w.capitalize() for w in words)


@router.get("", dependencies=[Depends(get_current_user)])
async def list_docs() -> list[dict]:
    """List available documents, one per docs/*.md file, sorted by title."""
    docs_dir = _docs_dir()
    if not docs_dir.is_dir():
        return []
    items = [
        {"slug": f.stem, "title": _title_from_filename(f.name)}
        for f in docs_dir.glob("*.md")
    ]
    items.sort(key=lambda d: d["title"])
    return items


@router.get("/{slug}", dependencies=[Depends(get_current_user)])
async def get_doc(slug: str) -> dict:
    """Return the raw markdown content of one doc, identified by filename stem.

    The path is never built from the request. `slug` selects from the files
    actually present in docs/, so the value that reaches the filesystem is one
    this process enumerated rather than one a caller supplied — no traversal is
    expressible, and a scanner can see that without having to trust a regex.
    """
    if not re.fullmatch(r"[A-Za-z0-9_-]+", slug):
        raise HTTPException(400, "Invalid document identifier")

    docs_dir = _docs_dir()
    if not docs_dir.is_dir():
        raise HTTPException(404, "Document not found")

    path = next((f for f in docs_dir.glob("*.md") if f.stem == slug), None)
    if path is None:
        raise HTTPException(404, "Document not found")

    return {"slug": slug, "title": _title_from_filename(path.name), "content": path.read_text()}
