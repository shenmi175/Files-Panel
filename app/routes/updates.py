from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.core.auth import require_auth
from app.models import (
    BatchUpdateTriggerResponse,
    UpdateStatusResponse,
    UpdateTriggerRequest,
    UpdateTriggerResponse,
)
from app.services.remote_nodes import remote_json_request
from app.services import updates as update_service


router = APIRouter(prefix="/api/update", tags=["update"], dependencies=[Depends(require_auth)])


@router.get("/status", response_model=UpdateStatusResponse)
def get_update_status(server_id: int | None = Query(default=None)) -> UpdateStatusResponse:
    if server_id is not None:
        return UpdateStatusResponse.model_validate(
            remote_json_request(server_id, method="GET", path="/api/update/status")
        )
    return update_service.build_update_status()


@router.post("", response_model=UpdateTriggerResponse)
def trigger_update(
    request: UpdateTriggerRequest,
    server_id: int | None = Query(default=None),
) -> UpdateTriggerResponse:
    if server_id is not None:
        return UpdateTriggerResponse.model_validate(
            remote_json_request(
                server_id,
                method="POST",
                path="/api/update",
                json_body=request.model_dump(),
            )
        )
    return update_service.schedule_update(request)


@router.post("/all-nodes", response_model=BatchUpdateTriggerResponse)
def trigger_all_node_updates(request: UpdateTriggerRequest) -> BatchUpdateTriggerResponse:
    return update_service.schedule_all_remote_updates(request)
