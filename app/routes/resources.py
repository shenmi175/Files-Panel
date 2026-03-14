from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.core.auth import require_auth
from app.models import ResourceHistoryResponse, ResourceSnapshot
from app.services import resources as resource_service


router = APIRouter(prefix="/api", tags=["resources"], dependencies=[Depends(require_auth)])


@router.get("/resources", response_model=ResourceSnapshot)
def get_resources(fresh: bool = Query(default=False)) -> ResourceSnapshot:
    snapshot = resource_service.get_resource_snapshot(force_refresh=fresh)
    resource_service.record_resource_history(snapshot, min_interval_seconds=5)
    return snapshot


@router.get("/resources/history", response_model=ResourceHistoryResponse)
def get_resource_history() -> ResourceHistoryResponse:
    return resource_service.get_resource_history()
