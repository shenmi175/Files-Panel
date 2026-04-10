from __future__ import annotations

from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Query

from app.core.auth import require_auth
from app.core.version import DEFAULT_UPDATE_CHANNEL, UPDATE_CHANNEL_CHOICES, normalize_update_channel
from app.models import (
    BatchUpdateTriggerResponse,
    UpdateStatusResponse,
    UpdateTriggerRequest,
    UpdateTriggerResponse,
)
from app.services.remote_nodes import remote_json_request
from app.services import updates as update_service


router = APIRouter(prefix="/api/update", tags=["update"], dependencies=[Depends(require_auth)])


def _normalize_remote_update_status_payload(payload: dict[str, object]) -> dict[str, object]:
    normalized = dict(payload)
    channel = normalize_update_channel(
        str(payload.get("channel")) if payload.get("channel") else None,
        fallback=DEFAULT_UPDATE_CHANNEL,
    )
    normalized.setdefault("channel", channel)
    normalized.setdefault("available_channels", list(UPDATE_CHANNEL_CHOICES))
    normalized.setdefault("channel_ref", f"origin/{channel}")
    normalized.setdefault(
        "channel_exists",
        bool(payload.get("git_repo")) or bool(payload.get("latest_version")),
    )
    return normalized


def _normalize_remote_update_response(payload: dict[str, object]) -> dict[str, object]:
    normalized = dict(payload)
    status_payload = normalized.get("status")
    if isinstance(status_payload, dict):
        normalized["status"] = _normalize_remote_update_status_payload(status_payload)
    return normalized


@router.get("/status", response_model=UpdateStatusResponse)
def get_update_status(
    server_id: int | None = Query(default=None),
    channel: str | None = Query(default=None),
) -> UpdateStatusResponse:
    if server_id is not None:
        path = "/api/update/status"
        if channel:
            path = f"{path}?{urlencode({'channel': channel})}"
        return UpdateStatusResponse.model_validate(
            _normalize_remote_update_status_payload(
                remote_json_request(server_id, method="GET", path=path)
            )
        )
    return update_service.build_update_status(channel_override=channel)


@router.post("", response_model=UpdateTriggerResponse)
def trigger_update(
    request: UpdateTriggerRequest,
    server_id: int | None = Query(default=None),
) -> UpdateTriggerResponse:
    if server_id is not None:
        return UpdateTriggerResponse.model_validate(
            _normalize_remote_update_response(
                remote_json_request(
                    server_id,
                    method="POST",
                    path="/api/update",
                    json_body=request.model_dump(),
                )
            )
        )
    return update_service.schedule_update(request)


@router.post("/all-nodes", response_model=BatchUpdateTriggerResponse)
def trigger_all_node_updates(request: UpdateTriggerRequest) -> BatchUpdateTriggerResponse:
    return update_service.schedule_all_remote_updates(request)
