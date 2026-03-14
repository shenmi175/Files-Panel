from __future__ import annotations

from urllib.parse import urlparse

from fastapi import HTTPException

from app.core.settings import SETTINGS
from app.core.storage import create_server, delete_server, list_servers, load_access_state, update_server, upsert_local_server
from app.models import ServerListResponse, ServerMutationResponse, ServerRecord, ServerUpsertRequest


def normalize_optional_text(raw_value: str | None) -> str | None:
    value = (raw_value or "").strip()
    return value or None


def normalize_base_url(raw_value: str | None, wireguard_ip: str | None) -> str | None:
    value = normalize_optional_text(raw_value)
    if value is None and wireguard_ip:
        return f"http://{wireguard_ip}:3000"
    if value is None:
        return None

    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="base url must include http/https and host")
    return value.rstrip("/")


def build_server_record(payload: dict[str, object]) -> ServerRecord:
    return ServerRecord(
        id=int(payload["id"]),
        name=str(payload["name"]),
        base_url=str(payload["base_url"]) if payload.get("base_url") else None,
        wireguard_ip=str(payload["wireguard_ip"]) if payload.get("wireguard_ip") else None,
        enabled=bool(payload["enabled"]),
        is_local=bool(payload["is_local"]),
        last_seen_at=str(payload["last_seen_at"]) if payload.get("last_seen_at") else None,
        created_at=str(payload["created_at"]),
        updated_at=str(payload["updated_at"]),
    )


def sync_local_server_record() -> None:
    access_state = load_access_state()
    base_url = access_state.get("public_url") or f"http://127.0.0.1:{SETTINGS.port}"
    upsert_local_server(
        name=SETTINGS.agent_name,
        base_url=str(base_url),
        wireguard_ip=None,
    )


def get_servers() -> ServerListResponse:
    sync_local_server_record()
    return ServerListResponse(items=[build_server_record(item) for item in list_servers()])


def get_server_record(server_id: int) -> ServerRecord:
    for item in list_servers():
        if int(item["id"]) == server_id:
            return build_server_record(item)
    raise HTTPException(status_code=404, detail="server not found")


def create_server_entry(request: ServerUpsertRequest) -> ServerMutationResponse:
    name = request.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="server name is required")

    wireguard_ip = normalize_optional_text(request.wireguard_ip)
    server_id = create_server(
        name=name,
        base_url=normalize_base_url(request.base_url, wireguard_ip),
        auth_token=normalize_optional_text(request.auth_token),
        wireguard_ip=wireguard_ip,
        enabled=bool(request.enabled),
    )
    return ServerMutationResponse(message="server saved", server=get_server_record(server_id))


def update_server_entry(server_id: int, request: ServerUpsertRequest) -> ServerMutationResponse:
    existing = get_server_record(server_id)
    if existing.is_local:
        raise HTTPException(status_code=400, detail="local server record is managed automatically")

    name = request.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="server name is required")

    wireguard_ip = normalize_optional_text(request.wireguard_ip)
    next_token = normalize_optional_text(request.auth_token)
    update_server(
        server_id,
        name=name,
        base_url=normalize_base_url(request.base_url, wireguard_ip),
        auth_token=next_token,
        wireguard_ip=wireguard_ip,
        enabled=bool(request.enabled),
    )
    return ServerMutationResponse(message="server updated", server=get_server_record(server_id))


def delete_server_entry(server_id: int) -> None:
    existing = get_server_record(server_id)
    if existing.is_local:
        raise HTTPException(status_code=400, detail="local server record cannot be removed")
    delete_server(server_id)
