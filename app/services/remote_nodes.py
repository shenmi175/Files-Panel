from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from email.message import Message
from typing import Any
from urllib import error, parse, request

from fastapi import HTTPException, UploadFile

from app.core import storage
from app.services.common import utc_now


REMOTE_REQUEST_TIMEOUT_SECONDS = 20


@dataclass(frozen=True)
class RemoteServerContext:
    id: int
    name: str
    base_url: str
    auth_token: str
    wireguard_ip: str | None


@dataclass(frozen=True)
class RemoteDownloadPayload:
    content: bytes
    media_type: str
    filename: str | None


def get_remote_server_context(server_id: int) -> RemoteServerContext:
    payload = storage.load_server_by_id(server_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="server not found")
    if bool(payload["is_local"]):
        raise HTTPException(status_code=400, detail="server_id points to the local node")
    if not bool(payload["enabled"]):
        raise HTTPException(status_code=400, detail="remote server is disabled")

    base_url = str(payload.get("base_url") or "").strip().rstrip("/")
    auth_token = str(payload.get("auth_token") or "").strip()
    if not base_url:
        raise HTTPException(status_code=400, detail="remote server base_url is not configured")
    if not auth_token:
        raise HTTPException(status_code=400, detail="remote server token is not configured")

    return RemoteServerContext(
        id=int(payload["id"]),
        name=str(payload["name"]),
        base_url=base_url,
        auth_token=auth_token,
        wireguard_ip=str(payload["wireguard_ip"]) if payload.get("wireguard_ip") else None,
    )


def _remote_error_detail(body: bytes, *, fallback: str) -> str:
    if not body:
        return fallback
    decoded = body.decode("utf-8", errors="replace").strip()
    if not decoded:
        return fallback
    try:
        parsed = json.loads(decoded)
    except json.JSONDecodeError:
        return decoded
    if isinstance(parsed, dict):
        detail = parsed.get("detail") or parsed.get("error") or parsed.get("message")
        if isinstance(detail, str) and detail.strip():
            return detail.strip()
    return decoded


def _touch_last_seen(server_id: int) -> None:
    storage.touch_server_last_seen(server_id, last_seen_at=utc_now())


def _build_remote_url(path: str, *, server: RemoteServerContext, params: dict[str, Any] | None = None) -> str:
    query = parse.urlencode(
        {
            key: value
            for key, value in (params or {}).items()
            if value is not None
        },
        doseq=True,
    )
    if query:
        return f"{server.base_url}{path}?{query}"
    return f"{server.base_url}{path}"


def remote_json_request(
    server_id: int,
    *,
    method: str,
    path: str,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    server = get_remote_server_context(server_id)
    payload_bytes = None
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {server.auth_token}",
    }
    if json_body is not None:
        payload_bytes = json.dumps(json_body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    remote_request = request.Request(
        _build_remote_url(path, server=server, params=params),
        data=payload_bytes,
        headers=headers,
        method=method.upper(),
    )
    try:
        with request.urlopen(remote_request, timeout=REMOTE_REQUEST_TIMEOUT_SECONDS) as response:
            raw_body = response.read()
    except error.HTTPError as exc:
        raise HTTPException(
            status_code=exc.code,
            detail=_remote_error_detail(exc.read(), fallback="remote request failed"),
        ) from exc
    except error.URLError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"failed to reach remote server {server.name}: {exc.reason}",
        ) from exc

    try:
        parsed = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail="remote server returned invalid JSON") from exc

    _touch_last_seen(server.id)
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=502, detail="remote server returned an unexpected response")
    return parsed


def remote_upload_request(
    server_id: int,
    *,
    path: str | None,
    file: UploadFile,
    browse_mode: str | None = None,
) -> dict[str, Any]:
    server = get_remote_server_context(server_id)
    boundary = f"----FilePanel{secrets.token_hex(12)}"
    filename = file.filename or "upload.bin"
    file_bytes = file.file.read()
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode("utf-8") + file_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")

    remote_request = request.Request(
        _build_remote_url(
            "/api/files/upload",
            server=server,
            params={"path": path, "browse_mode": browse_mode},
        ),
        data=body,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {server.auth_token}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    try:
        with request.urlopen(remote_request, timeout=REMOTE_REQUEST_TIMEOUT_SECONDS) as response:
            raw_body = response.read()
    except error.HTTPError as exc:
        raise HTTPException(
            status_code=exc.code,
            detail=_remote_error_detail(exc.read(), fallback="remote upload failed"),
        ) from exc
    except error.URLError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"failed to reach remote server {server.name}: {exc.reason}",
        ) from exc
    finally:
        file.file.close()

    try:
        parsed = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail="remote server returned invalid JSON") from exc

    _touch_last_seen(server.id)
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=502, detail="remote server returned an unexpected response")
    return parsed


def remote_download_request(
    server_id: int,
    *,
    path: str,
    browse_mode: str | None = None,
) -> RemoteDownloadPayload:
    server = get_remote_server_context(server_id)
    remote_request = request.Request(
        _build_remote_url(
            "/api/files/download",
            server=server,
            params={"path": path, "browse_mode": browse_mode},
        ),
        headers={
            "Authorization": f"Bearer {server.auth_token}",
        },
        method="GET",
    )
    try:
        with request.urlopen(remote_request, timeout=REMOTE_REQUEST_TIMEOUT_SECONDS) as response:
            content = response.read()
            media_type = response.headers.get_content_type() or "application/octet-stream"
            disposition = response.headers.get("Content-Disposition")
    except error.HTTPError as exc:
        raise HTTPException(
            status_code=exc.code,
            detail=_remote_error_detail(exc.read(), fallback="remote download failed"),
        ) from exc
    except error.URLError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"failed to reach remote server {server.name}: {exc.reason}",
        ) from exc

    filename: str | None = None
    if disposition:
        header = Message()
        header["content-disposition"] = disposition
        filename = header.get_param("filename", header="content-disposition")
    _touch_last_seen(server.id)
    return RemoteDownloadPayload(
        content=content,
        media_type=media_type,
        filename=filename,
    )


def validate_remote_server(base_url: str, auth_token: str) -> dict[str, Any]:
    server = RemoteServerContext(
        id=0,
        name=base_url,
        base_url=base_url.rstrip("/"),
        auth_token=auth_token,
        wireguard_ip=None,
    )
    payload_bytes = None
    remote_request = request.Request(
        _build_remote_url("/api/agent", server=server),
        data=payload_bytes,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {auth_token}",
        },
        method="GET",
    )
    try:
        with request.urlopen(remote_request, timeout=REMOTE_REQUEST_TIMEOUT_SECONDS) as response:
            raw_body = response.read()
    except error.HTTPError as exc:
        raise HTTPException(
            status_code=400,
            detail=_remote_error_detail(exc.read(), fallback="remote node validation failed"),
        ) from exc
    except error.URLError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"failed to reach remote node: {exc.reason}",
        ) from exc

    try:
        parsed = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="remote node returned invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="remote node returned an unexpected response")
    return parsed
