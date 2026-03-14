from __future__ import annotations

from fastapi import APIRouter, Depends

from app.core.auth import require_auth
from app.models import MessageResponse, ServerListResponse, ServerMutationResponse, ServerUpsertRequest
from app.services import servers as server_service


router = APIRouter(prefix="/api/servers", tags=["servers"], dependencies=[Depends(require_auth)])


@router.get("", response_model=ServerListResponse)
def list_server_entries() -> ServerListResponse:
    return server_service.get_servers()


@router.post("", response_model=ServerMutationResponse)
def create_server_entry(request: ServerUpsertRequest) -> ServerMutationResponse:
    return server_service.create_server_entry(request)


@router.put("/{server_id}", response_model=ServerMutationResponse)
def update_server_entry(server_id: int, request: ServerUpsertRequest) -> ServerMutationResponse:
    return server_service.update_server_entry(server_id, request)


@router.delete("/{server_id}", response_model=MessageResponse)
def delete_server_entry(server_id: int) -> MessageResponse:
    server_service.delete_server_entry(server_id)
    return MessageResponse(message="server removed")
