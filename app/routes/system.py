from __future__ import annotations

import os
import pwd
import socket

from fastapi import APIRouter

from app.core.settings import SETTINGS
from app.models import AgentInfo, HealthResponse
from app.services.common import utc_now


router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", timestamp=utc_now(), auth_enabled=bool(SETTINGS.auth_token))


@router.get("/agent", response_model=AgentInfo)
async def agent_info() -> AgentInfo:
    return AgentInfo(
        agent_name=SETTINGS.agent_name,
        hostname=socket.gethostname(),
        current_user=pwd.getpwuid(os.getuid()).pw_name,
        root_path=str(SETTINGS.root_path),
        auth_enabled=bool(SETTINGS.auth_token),
    )
