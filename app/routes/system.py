from __future__ import annotations

import os
import pwd
import socket

from fastapi import APIRouter, Depends, Query

from app.core.auth import browser_auth_enabled, registration_required, require_auth
from app.core.settings import SETTINGS
from app.models import AgentInfo, HealthResponse
from app.services.common import utc_now
from app.services.remote_nodes import remote_json_request


router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        timestamp=utc_now(),
        auth_enabled=browser_auth_enabled(),
        registration_required=registration_required(),
    )


@router.get("/agent", response_model=AgentInfo, dependencies=[Depends(require_auth)])
def agent_info(server_id: int | None = Query(default=None)) -> AgentInfo:
    if server_id is not None:
        return AgentInfo.model_validate(
            remote_json_request(server_id, method="GET", path="/api/agent")
        )
    return AgentInfo(
        agent_name=SETTINGS.agent_name,
        hostname=socket.gethostname(),
        current_user=pwd.getpwuid(os.getuid()).pw_name,
        root_path=str(SETTINGS.root_path),
        auth_enabled=browser_auth_enabled(),
    )
