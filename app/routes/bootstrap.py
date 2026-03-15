from __future__ import annotations

from fastapi import APIRouter, Depends, Header

from app.core.auth import require_auth
from app.models import (
    WireGuardBootstrapPrepareRequest,
    WireGuardBootstrapPrepareResponse,
    WireGuardBootstrapRegisterRequest,
    WireGuardBootstrapRegisterResponse,
    WireGuardBootstrapStatusResponse,
)
from app.services import wireguard_bootstrap as bootstrap_service


router = APIRouter(prefix="/api/bootstrap", tags=["bootstrap"])


@router.get("/wireguard/status", response_model=WireGuardBootstrapStatusResponse, dependencies=[Depends(require_auth)])
def wireguard_bootstrap_status() -> WireGuardBootstrapStatusResponse:
    return bootstrap_service.build_wireguard_bootstrap_status()


@router.post("/wireguard/prepare", response_model=WireGuardBootstrapPrepareResponse, dependencies=[Depends(require_auth)])
def prepare_wireguard_bootstrap(
    request: WireGuardBootstrapPrepareRequest,
) -> WireGuardBootstrapPrepareResponse:
    return bootstrap_service.prepare_wireguard_bootstrap(request)


@router.post("/wireguard/register", response_model=WireGuardBootstrapRegisterResponse)
def register_wireguard_agent(
    request: WireGuardBootstrapRegisterRequest,
    authorization: str | None = Header(default=None),
) -> WireGuardBootstrapRegisterResponse:
    return bootstrap_service.register_wireguard_agent(request, authorization=authorization)
