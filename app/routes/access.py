from __future__ import annotations

from fastapi import APIRouter, Depends

from app.core.auth import require_auth
from app.models import (
    AccessStatus,
    ConfigResponse,
    ConfigUpdateRequest,
    ConfigUpdateResponse,
    DomainSetupRequest,
    DomainSetupResponse,
    TokenResetResponse,
)
from app.services import access as access_service


router = APIRouter(prefix="/api", tags=["access"], dependencies=[Depends(require_auth)])


@router.get("/access", response_model=AccessStatus)
def get_access_status() -> AccessStatus:
    return access_service.build_access_status()


@router.get("/config", response_model=ConfigResponse)
def get_config() -> ConfigResponse:
    return access_service.build_config_response()


@router.post("/config", response_model=ConfigUpdateResponse)
def update_config(request: ConfigUpdateRequest) -> ConfigUpdateResponse:
    return access_service.update_config(request)


@router.post("/config/reset-token", response_model=TokenResetResponse)
def reset_config_token() -> TokenResetResponse:
    return access_service.reset_agent_token()


@router.post("/access/domain", response_model=DomainSetupResponse)
def configure_domain_access(request: DomainSetupRequest) -> DomainSetupResponse:
    return access_service.configure_domain_access(request)
