"""
POST /api/auth/* — login, logout, token refresh, Okta OIDC callback.
"""
from __future__ import annotations

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel

from app.auth.local import verify_password, create_access_token, create_refresh_token, decode_refresh_token
from app.database import get_db

router = APIRouter()


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, response: Response, db: aiosqlite.Connection = Depends(get_db)):
    async with db.execute(
        "SELECT id, hashed_password, role, is_active FROM users WHERE username = ? OR email = ?",
        (body.username, body.username),
    ) as cur:
        user = await cur.fetchone()

    if not user or not user["is_active"]:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    if not user["hashed_password"] or not verify_password(body.password, user["hashed_password"]):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    # Update last_login
    await db.execute("UPDATE users SET last_login = datetime('now') WHERE id = ?", (user["id"],))
    await db.commit()

    access_token = create_access_token(user["id"], user["role"])
    refresh_token = create_refresh_token(user["id"])

    # Refresh token in httpOnly cookie
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 7,  # 7 days
    )

    return TokenResponse(access_token=access_token, role=user["role"])


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(
    request: "Request",  # type: ignore[name-defined]  # noqa: F821
    db: aiosqlite.Connection = Depends(get_db),
):
    from fastapi import Request
    token = request.cookies.get("refresh_token")
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No refresh token")

    user_id = decode_refresh_token(token)
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    async with db.execute(
        "SELECT id, role, is_active FROM users WHERE id = ?", (user_id,)
    ) as cur:
        user = await cur.fetchone()

    if not user or not user["is_active"]:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    access_token = create_access_token(user["id"], user["role"])
    return TokenResponse(access_token=access_token, role=user["role"])


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie("refresh_token")
    return {"message": "Logged out"}
