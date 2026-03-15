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
from .storage import load_admin_account


SESSION_COOKIE_NAME = "file_panel_session"
SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12
SESSION_COOKIE_VERSION = 1
PASSWORD_HASH_ITERATIONS = 390000


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _session_secret(account: dict[str, str]) -> bytes:
    return f"{account['password_hash']}:{account['password_salt']}".encode("utf-8")


def _session_signature(payload: bytes, secret_key: bytes) -> bytes:
    return hmac.new(secret_key, payload, hashlib.sha256).digest()


def browser_auth_enabled() -> bool:
    return SETTINGS.role == "manager"


def registration_required() -> bool:
    if not browser_auth_enabled():
        return False
    return load_admin_account() is None


def has_valid_agent_token(authorization: str | None) -> bool:
    expected = SETTINGS.auth_token
    if not expected:
        return False

    scheme, _, token = (authorization or "").partition(" ")
    return scheme.lower() == "bearer" and bool(token) and secrets.compare_digest(token, expected)


def _parse_session_cookie(session_cookie: str | None) -> dict[str, int | str] | None:
    account = load_admin_account()
    if account is None or not session_cookie:
        return None

    try:
        encoded_payload, encoded_signature = session_cookie.split(".", 1)
        payload = _b64url_decode(encoded_payload)
        signature = _b64url_decode(encoded_signature)
    except (ValueError, TypeError, binascii.Error):
        return None

    expected_signature = _session_signature(payload, _session_secret(account))
    if not secrets.compare_digest(signature, expected_signature):
        return None

    try:
        parsed_payload = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None

    expires_at = int(parsed_payload.get("exp", 0))
    version = int(parsed_payload.get("v", 0))
    username = str(parsed_payload.get("username", ""))
    if (
        version != SESSION_COOKIE_VERSION
        or expires_at < int(time.time())
        or username != account["username"]
    ):
        return None
    return parsed_payload


def current_session_username(session_cookie: str | None) -> str | None:
    payload = _parse_session_cookie(session_cookie)
    if payload is None:
        return None
    return str(payload["username"])


def build_session_cookie_value(username: str) -> str:
    account = load_admin_account()
    if account is None or username != account["username"]:
        return ""

    issued_at = int(time.time())
    payload = json.dumps(
        {
            "v": SESSION_COOKIE_VERSION,
            "iat": issued_at,
            "exp": issued_at + SESSION_COOKIE_MAX_AGE_SECONDS,
            "username": username,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    signature = _session_signature(payload, _session_secret(account))
    return f"{_b64url_encode(payload)}.{_b64url_encode(signature)}"


def has_valid_session_cookie(session_cookie: str | None) -> bool:
    return current_session_username(session_cookie) is not None


def hash_password(password: str, *, salt: str | None = None) -> tuple[str, str]:
    salt_bytes = _b64url_decode(salt) if salt else secrets.token_bytes(16)
    password_hash = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt_bytes,
        PASSWORD_HASH_ITERATIONS,
    )
    return _b64url_encode(password_hash), _b64url_encode(salt_bytes)


def verify_password(password: str, password_hash: str, password_salt: str) -> bool:
    candidate_hash, _ = hash_password(password, salt=password_salt)
    return secrets.compare_digest(candidate_hash, password_hash)


def is_request_authenticated(
    authorization: str | None,
    session_cookie: str | None,
    *,
    allow_agent_token: bool = False,
) -> bool:
    if has_valid_session_cookie(session_cookie):
        return True
    return allow_agent_token and has_valid_agent_token(authorization)


def set_session_cookie(response: Response, request: Request, *, username: str) -> None:
    cookie_value = build_session_cookie_value(username)
    if not cookie_value:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="session could not be created",
        )
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=cookie_value,
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
    if is_request_authenticated(authorization, session_cookie, allow_agent_token=True):
        return

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="authentication required",
        headers={"WWW-Authenticate": "Session"},
    )


def require_agent_token(authorization: str | None = Header(default=None)) -> None:
    if has_valid_agent_token(authorization):
        return
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="agent token required",
        headers={"WWW-Authenticate": "Bearer"},
    )
