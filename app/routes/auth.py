from __future__ import annotations

import re

from fastapi import APIRouter, Cookie, HTTPException, Request, Response, status

from app.core.auth import (
    SESSION_COOKIE_NAME,
    browser_auth_enabled,
    clear_session_cookie,
    current_session_username,
    hash_password,
    registration_required,
    set_session_cookie,
    verify_password,
)
from app.core.storage import load_admin_account, save_admin_account
from app.models import (
    LoginRequest,
    LoginResponse,
    MessageResponse,
    RegisterRequest,
    SessionStatusResponse,
)


router = APIRouter(prefix="/api/auth", tags=["auth"])
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.@-]{2,63}$")


def normalize_username(raw_username: str) -> str:
    username = raw_username.strip()
    if not USERNAME_PATTERN.fullmatch(username):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="username must be 3-64 characters and use letters, numbers, ., _, @ or -",
        )
    return username


@router.get("/session", response_model=SessionStatusResponse)
def get_session_status(
    session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> SessionStatusResponse:
    username = current_session_username(session_cookie)
    return SessionStatusResponse(
        auth_enabled=browser_auth_enabled(),
        authenticated=username is not None,
        registration_required=registration_required(),
        username=username,
    )


@router.post("/register", response_model=LoginResponse)
def register(
    payload: RegisterRequest,
    request: Request,
    response: Response,
) -> LoginResponse:
    if load_admin_account() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="an administrator account is already registered",
        )

    username = normalize_username(payload.username)
    password_hash, password_salt = hash_password(payload.password)
    save_admin_account(
        username=username,
        password_hash=password_hash,
        password_salt=password_salt,
    )
    set_session_cookie(response, request, username=username)
    return LoginResponse(
        message="administrator account registered",
        authenticated=True,
        username=username,
    )


@router.post("/login", response_model=LoginResponse)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
) -> LoginResponse:
    account = load_admin_account()
    if account is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="registration is required before login",
        )

    username = normalize_username(payload.username)
    if username != account["username"] or not verify_password(
        payload.password,
        account["password_hash"],
        account["password_salt"],
    ):
        clear_session_cookie(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid username or password",
            headers={"WWW-Authenticate": "Session"},
        )

    set_session_cookie(response, request, username=account["username"])
    return LoginResponse(
        message="login successful",
        authenticated=True,
        username=account["username"],
    )


@router.post("/logout", response_model=MessageResponse)
def logout(response: Response) -> MessageResponse:
    clear_session_cookie(response)
    return MessageResponse(message="logged out")
