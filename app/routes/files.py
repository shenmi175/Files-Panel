from __future__ import annotations

from pathlib import Path
from urllib.parse import urlencode

from fastapi import APIRouter, Cookie, Depends, File, Header, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse

from app.core.auth import SESSION_COOKIE_NAME, is_request_authenticated, require_auth
from app.models import (
    CreateDirectoryRequest,
    DownloadLinkResponse,
    FileListResponse,
    MessageResponse,
    RenameFileRequest,
)
from app.services import files as file_service
from app.services.remote_nodes import remote_download_request, remote_json_request, remote_upload_request


router = APIRouter(prefix="/api/files", tags=["files"])


@router.get("", response_model=FileListResponse, dependencies=[Depends(require_auth)])
def list_files(
    path: str | None = Query(default=None),
    show_hidden: bool = Query(default=False),
    browse_mode: str | None = Query(default=None),
    server_id: int | None = Query(default=None),
) -> FileListResponse:
    if server_id is not None:
        params: dict[str, object] = {}
        if path is not None:
            params["path"] = path
        if show_hidden:
            params["show_hidden"] = "true"
        if browse_mode:
            params["browse_mode"] = browse_mode
        return FileListResponse.model_validate(
            remote_json_request(
                server_id,
                method="GET",
                path="/api/files",
                params=params or None,
            )
        )
    return file_service.build_file_list(path, show_hidden, browse_mode=browse_mode)


@router.post("/mkdir", response_model=MessageResponse, dependencies=[Depends(require_auth)])
def create_directory(
    request: CreateDirectoryRequest,
    server_id: int | None = Query(default=None),
) -> MessageResponse:
    if server_id is not None:
        return MessageResponse.model_validate(
            remote_json_request(
                server_id,
                method="POST",
                path="/api/files/mkdir",
                json_body=request.model_dump(),
            )
        )
    return file_service.create_directory(request)


@router.delete("", response_model=MessageResponse, dependencies=[Depends(require_auth)])
def delete_path(
    path: str = Query(...),
    browse_mode: str | None = Query(default=None),
    server_id: int | None = Query(default=None),
) -> MessageResponse:
    if server_id is not None:
        params: dict[str, object] = {"path": path}
        if browse_mode:
            params["browse_mode"] = browse_mode
        return MessageResponse.model_validate(
            remote_json_request(
                server_id,
                method="DELETE",
                path="/api/files",
                params=params,
            )
        )
    return file_service.delete_path(path, browse_mode=browse_mode)


@router.post("/rename", response_model=MessageResponse, dependencies=[Depends(require_auth)])
def rename_path(
    request: RenameFileRequest,
    server_id: int | None = Query(default=None),
) -> MessageResponse:
    if server_id is not None:
        return MessageResponse.model_validate(
            remote_json_request(
                server_id,
                method="POST",
                path="/api/files/rename",
                json_body=request.model_dump(),
            )
        )
    return file_service.rename_path(request)


@router.post("/upload", response_model=MessageResponse, dependencies=[Depends(require_auth)])
def upload_file(
    file: UploadFile = File(...),
    path: str | None = Query(default=None),
    browse_mode: str | None = Query(default=None),
    server_id: int | None = Query(default=None),
) -> MessageResponse:
    if server_id is not None:
        return MessageResponse.model_validate(
            remote_upload_request(server_id, path=path, file=file, browse_mode=browse_mode)
        )
    return file_service.upload_file(file, path, browse_mode=browse_mode)


@router.get("/download-link", response_model=DownloadLinkResponse, dependencies=[Depends(require_auth)])
def download_link(
    request: Request,
    path: str = Query(...),
    browse_mode: str | None = Query(default=None),
    server_id: int | None = Query(default=None),
) -> DownloadLinkResponse:
    if server_id is not None:
        params: dict[str, object] = {"path": path, "server_id": server_id}
        if browse_mode:
            params["browse_mode"] = browse_mode
        download_url = f"{request.url_for('download_file')}?{urlencode(params)}"
        return DownloadLinkResponse(url=download_url, expires_in_seconds=0)
    return file_service.build_download_link(path, request, browse_mode=browse_mode)


@router.get("/download")
def download_file(
    path: str = Query(...),
    server_id: int | None = Query(default=None),
    browse_mode: str | None = Query(default=None),
    download_token: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
    session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> Response:
    if server_id is not None:
        if not is_request_authenticated(authorization, session_cookie, allow_agent_token=True):
            raise HTTPException(status_code=403, detail="download authorization required")
        payload = remote_download_request(server_id, path=path, browse_mode=browse_mode)
        filename = (payload.filename or Path(path).name or "download.bin").replace('"', "")
        return Response(
            content=payload.content,
            media_type=payload.media_type,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    if file_service.normalize_browse_mode(browse_mode) == file_service.SYSTEM_BROWSE_MODE:
        if not is_request_authenticated(authorization, session_cookie, allow_agent_token=True):
            raise HTTPException(status_code=403, detail="download authorization required")
        return file_service.download_file(path, browse_mode=browse_mode)

    target = file_service.resolve_existing_file(path)
    if not (
        is_request_authenticated(authorization, session_cookie, allow_agent_token=True)
        or file_service.validate_download_token(target, download_token)
    ):
        raise HTTPException(status_code=403, detail="download authorization required")
    return file_service.download_file(str(target), browse_mode=browse_mode)
