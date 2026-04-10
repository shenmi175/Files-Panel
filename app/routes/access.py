from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.core.auth import require_auth
from app.core.storage import update_server_auth_token
from app.core.version import DEFAULT_UPDATE_CHANNEL, UPDATE_CHANNEL_CHOICES, normalize_update_channel
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
from app.services.remote_nodes import remote_json_request


router = APIRouter(prefix="/api", tags=["access"], dependencies=[Depends(require_auth)])


def _normalize_remote_config_payload(payload: dict[str, object]) -> dict[str, object]:
    normalized = dict(payload)
    channel = normalize_update_channel(
        str(payload.get("update_channel")) if payload.get("update_channel") else None,
        fallback=DEFAULT_UPDATE_CHANNEL,
    )
    normalized.setdefault("update_channel", channel)
    normalized.setdefault("available_update_channels", list(UPDATE_CHANNEL_CHOICES))
    return normalized


def _normalize_remote_config_response(payload: dict[str, object]) -> dict[str, object]:
    normalized = dict(payload)
    config_payload = normalized.get("config")
    if isinstance(config_payload, dict):
        normalized["config"] = _normalize_remote_config_payload(config_payload)
    return normalized


@router.get("/access", response_model=AccessStatus)
def get_access_status(server_id: int | None = Query(default=None)) -> AccessStatus:
    if server_id is not None:
        return AccessStatus.model_validate(
            remote_json_request(server_id, method="GET", path="/api/access")
        )
    return access_service.build_access_status()


@router.get("/config", response_model=ConfigResponse)
def get_config(server_id: int | None = Query(default=None)) -> ConfigResponse:
    if server_id is not None:
        return ConfigResponse.model_validate(
            _normalize_remote_config_payload(
                remote_json_request(server_id, method="GET", path="/api/config")
            )
        )
    return access_service.build_config_response()


@router.post("/config", response_model=ConfigUpdateResponse)
def update_config(
    request: ConfigUpdateRequest,
    server_id: int | None = Query(default=None),
) -> ConfigUpdateResponse:
    if server_id is not None:
        payload = _normalize_remote_config_response(
            remote_json_request(
                server_id,
                method="POST",
                path="/api/config",
                json_body=request.model_dump(),
            )
        )
        next_token = (request.agent_token or "").strip()
        if next_token:
            update_server_auth_token(server_id, next_token)
        return ConfigUpdateResponse.model_validate(payload)
    return access_service.update_config(request)


@router.post("/config/reset-token", response_model=TokenResetResponse)
def reset_config_token(server_id: int | None = Query(default=None)) -> TokenResetResponse:
    if server_id is not None:
        payload = _normalize_remote_config_response(
            remote_json_request(
                server_id,
                method="POST",
                path="/api/config/reset-token",
            )
        )
        rotated_token = str(payload.get("token") or "").strip()
        if rotated_token:
            update_server_auth_token(server_id, rotated_token)
        return TokenResetResponse.model_validate(payload)
    return access_service.reset_agent_token()


@router.post("/access/domain", response_model=DomainSetupResponse)
def configure_domain_access(
    request: DomainSetupRequest,
    server_id: int | None = Query(default=None),
) -> DomainSetupResponse:
    if server_id is not None:
        return DomainSetupResponse.model_validate(
            remote_json_request(
                server_id,
                method="POST",
                path="/api/access/domain",
                json_body=request.model_dump(),
            )
        )
    return access_service.configure_domain_access(request)
