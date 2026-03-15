from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.core.auth import require_auth
from app.models import DockerStatusResponse, LogsResponse
from app.services import runtime as runtime_service
from app.services.remote_nodes import remote_json_request


router = APIRouter(prefix="/api/runtime", tags=["runtime"], dependencies=[Depends(require_auth)])


@router.get("/docker", response_model=DockerStatusResponse)
def get_docker_status(server_id: int | None = Query(default=None)) -> DockerStatusResponse:
    if server_id is not None:
        return DockerStatusResponse.model_validate(
            remote_json_request(server_id, method="GET", path="/api/runtime/docker")
        )
    return runtime_service.get_docker_status()


@router.get("/logs", response_model=LogsResponse)
def get_runtime_logs(
    limit: int = Query(default=200, ge=20, le=200),
    cursor: str | None = Query(default=None),
    level: str = Query(default="info"),
    server_id: int | None = Query(default=None),
) -> LogsResponse:
    if server_id is not None:
        params = {"limit": limit, "level": level}
        if cursor:
            params["cursor"] = cursor
        return LogsResponse.model_validate(
            remote_json_request(
                server_id,
                method="GET",
                path="/api/runtime/logs",
                params=params,
            )
        )
    return runtime_service.get_runtime_logs(limit=limit, cursor=cursor, level=level)
