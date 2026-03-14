from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import secrets
import time

from fastapi import Cookie, Header, HTTPException, Request, Response, status

from .settings import SETTINGS


SESSION_COOKIE_NAME = "file_panel_session"
SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12
SESSION_COOKIE_VERSION = 1


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _session_signature(payload: bytes, token: str) -> bytes:
    return hmac.new(token.encode("utf-8"), payload, hashlib.sha256).digest()


def has_valid_bearer_token(authorization: str | None) -> bool:
    expected = SETTINGS.auth_token
    if not expected:
        return True

    scheme, _, token = (authorization or "").partition(" ")
    return scheme.lower() == "bearer" and bool(token) and secrets.compare_digest(token, expected)


def build_session_cookie_value() -> str:
    expected = SETTINGS.auth_token
    if not expected:
        return ""

    issued_at = int(time.time())
    payload = json.dumps(
        {
            "v": SESSION_COOKIE_VERSION,
            "iat": issued_at,
            "exp": issued_at + SESSION_COOKIE_MAX_AGE_SECONDS,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    signature = _session_signature(payload, expected)
    return f"{_b64url_encode(payload)}.{_b64url_encode(signature)}"


def has_valid_session_cookie(session_cookie: str | None) -> bool:
    expected = SETTINGS.auth_token
    if not expected:
        return True
    if not session_cookie:
        return False

    try:
        encoded_payload, encoded_signature = session_cookie.split(".", 1)
        payload = _b64url_decode(encoded_payload)
        signature = _b64url_decode(encoded_signature)
    except (ValueError, TypeError, binascii.Error):
        return False

    expected_signature = _session_signature(payload, expected)
    if not secrets.compare_digest(signature, expected_signature):
        return False

    try:
        parsed_payload = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False

    expires_at = int(parsed_payload.get("exp", 0))
    version = int(parsed_payload.get("v", 0))
    return version == SESSION_COOKIE_VERSION and expires_at >= int(time.time())


def is_request_authenticated(
    authorization: str | None,
    session_cookie: str | None,
) -> bool:
    if not SETTINGS.auth_token:
        return True
    return has_valid_bearer_token(authorization) or has_valid_session_cookie(session_cookie)


def set_session_cookie(response: Response, request: Request) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=build_session_cookie_value(),
        max_age=SESSION_COOKIE_MAX_AGE_SECONDS,
        httponly=True,
        samesite="strict",
        secure=request.url.scheme == "https",
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        httponly=True,
        samesite="strict",
        path="/",
    )


def require_auth(
    authorization: str | None = Header(default=None),
    session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> None:
    if is_request_authenticated(authorization, session_cookie):
        return

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="authentication required",
        headers={"WWW-Authenticate": "Bearer"},
    )
