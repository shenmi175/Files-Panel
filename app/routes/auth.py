from __future__ import annotations

from fastapi import APIRouter, Cookie, Header, HTTPException, Request, Response, status

from app.core.auth import (
    SESSION_COOKIE_NAME,
    clear_session_cookie,
    has_valid_bearer_token,
    is_request_authenticated,
    set_session_cookie,
)
from app.core.settings import SETTINGS
from app.models import LoginRequest, LoginResponse, MessageResponse, SessionStatusResponse


router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/session", response_model=SessionStatusResponse)
def get_session_status(
    authorization: str | None = Header(default=None),
    session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> SessionStatusResponse:
    return SessionStatusResponse(
        auth_enabled=bool(SETTINGS.auth_token),
        authenticated=is_request_authenticated(authorization, session_cookie),
    )


@router.post("/login", response_model=LoginResponse)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
) -> LoginResponse:
    if not SETTINGS.auth_token:
        return LoginResponse(message="authentication is disabled", authenticated=True)

    authorization = f"Bearer {payload.token.strip()}"
    if not has_valid_bearer_token(authorization):
        clear_session_cookie(response)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid access token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    set_session_cookie(response, request)
    return LoginResponse(message="login successful", authenticated=True)


@router.post("/logout", response_model=MessageResponse)
def logout(response: Response) -> MessageResponse:
    clear_session_cookie(response)
    return MessageResponse(message="logged out")
