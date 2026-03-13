from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.core.auth import require_auth
from app.models import DockerStatusResponse, LogsResponse
from app.services import runtime as runtime_service


router = APIRouter(prefix="/api/runtime", tags=["runtime"], dependencies=[Depends(require_auth)])


@router.get("/docker", response_model=DockerStatusResponse)
async def get_docker_status() -> DockerStatusResponse:
    return runtime_service.get_docker_status()


@router.get("/logs", response_model=LogsResponse)
async def get_runtime_logs(
    limit: int = Query(default=200, ge=20, le=200),
    cursor: str | None = Query(default=None),
    level: str = Query(default="info"),
) -> LogsResponse:
    return runtime_service.get_runtime_logs(limit=limit, cursor=cursor, level=level)
