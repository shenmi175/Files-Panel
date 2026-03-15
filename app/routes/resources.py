from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.core.auth import require_auth
from app.core.settings import SETTINGS
from app.models import ResourceHistoryResponse, ResourceSnapshot
from app.services import resources as resource_service
from app.services.remote_nodes import remote_json_request


router = APIRouter(prefix="/api", tags=["resources"], dependencies=[Depends(require_auth)])


@router.get("/resources", response_model=ResourceSnapshot)
def get_resources(
    fresh: bool = Query(default=False),
    server_id: int | None = Query(default=None),
) -> ResourceSnapshot:
    if server_id is not None:
        params = {"fresh": "true"} if fresh else None
        return ResourceSnapshot.model_validate(
            remote_json_request(
                server_id,
                method="GET",
                path="/api/resources",
                params=params,
            )
        )
    snapshot = resource_service.get_resource_snapshot(force_refresh=fresh)
    resource_service.record_resource_history(
        snapshot,
        min_interval_seconds=SETTINGS.sample_interval_seconds,
    )
    return snapshot


@router.get("/resources/history", response_model=ResourceHistoryResponse)
def get_resource_history(
    range: str = Query(default="1h"),
    server_id: int | None = Query(default=None),
) -> ResourceHistoryResponse:
    if server_id is not None:
        return ResourceHistoryResponse.model_validate(
            remote_json_request(
                server_id,
                method="GET",
                path="/api/resources/history",
                params={"range": range},
            )
        )
    return resource_service.get_resource_history(range)
