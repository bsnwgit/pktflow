"""
CRUD /api/users — admin user management.
"""
from __future__ import annotations

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from typing import Optional

from app.auth.local import hash_password
from app.database import get_db
from app.dependencies import AdminUser, CurrentUser

router = APIRouter()


class UserIn(BaseModel):
    username: str
    email: str
    password: Optional[str] = None
    role: str = "viewer"


class UserOut(BaseModel):
    id: int
    username: str
    email: str
    role: str
    is_active: bool
    created_at: str
    last_login: Optional[str]


@router.get("/", response_model=list[UserOut])
async def list_users(_: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute(
        "SELECT id, username, email, role, is_active, created_at, last_login FROM users ORDER BY username"
    ) as cur:
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


@router.post("/", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def create_user(body: UserIn, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    hashed = hash_password(body.password) if body.password else None
    try:
        async with db.execute(
            "INSERT INTO users (username, email, hashed_password, role) VALUES (?,?,?,?) RETURNING *",
            (body.username, body.email, hashed, body.role),
        ) as cur:
            row = await cur.fetchone()
        await db.commit()
        return dict(row)
    except aiosqlite.IntegrityError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.put("/{user_id}", response_model=UserOut)
async def update_user(
    user_id: int,
    body: UserIn,
    _: AdminUser,
    db: aiosqlite.Connection = Depends(get_db),
):
    update_fields = "username=?, email=?, role=?"
    params = [body.username, body.email, body.role]
    if body.password:
        update_fields += ", hashed_password=?"
        params.append(hash_password(body.password))
    params.append(user_id)
    await db.execute(f"UPDATE users SET {update_fields} WHERE id=?", params)
    await db.commit()
    async with db.execute(
        "SELECT id, username, email, role, is_active, created_at, last_login FROM users WHERE id=?",
        (user_id,),
    ) as cur:
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    return dict(row)


@router.patch("/{user_id}/deactivate", status_code=status.HTTP_204_NO_CONTENT)
async def deactivate_user(user_id: int, _: AdminUser, db: aiosqlite.Connection = Depends(get_db)):
    await db.execute("UPDATE users SET is_active = 0 WHERE id = ?", (user_id,))
    await db.commit()


@router.get("/me", response_model=UserOut)
async def get_me(user: CurrentUser):
    return user
