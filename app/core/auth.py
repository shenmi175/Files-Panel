from __future__ import annotations

import secrets

from fastapi import Header, HTTPException, status

from .settings import SETTINGS


def require_auth(authorization: str | None = Header(default=None)) -> None:
    expected = SETTINGS.auth_token
    if not expected:
        return

    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token or not secrets.compare_digest(token, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing or invalid bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
