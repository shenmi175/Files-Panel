from __future__ import annotations

from fastapi import APIRouter, Cookie, Depends, File, Header, HTTPException, Query, Request, UploadFile
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


router = APIRouter(prefix="/api/files", tags=["files"])


@router.get("", response_model=FileListResponse, dependencies=[Depends(require_auth)])
def list_files(
    path: str | None = Query(default=None),
    show_hidden: bool = Query(default=False),
) -> FileListResponse:
    return file_service.build_file_list(path, show_hidden)


@router.post("/mkdir", response_model=MessageResponse, dependencies=[Depends(require_auth)])
def create_directory(request: CreateDirectoryRequest) -> MessageResponse:
    return file_service.create_directory(request)


@router.delete("", response_model=MessageResponse, dependencies=[Depends(require_auth)])
def delete_path(path: str = Query(...)) -> MessageResponse:
    return file_service.delete_path(path)


@router.post("/rename", response_model=MessageResponse, dependencies=[Depends(require_auth)])
def rename_path(request: RenameFileRequest) -> MessageResponse:
    return file_service.rename_path(request)


@router.post("/upload", response_model=MessageResponse, dependencies=[Depends(require_auth)])
def upload_file(
    file: UploadFile = File(...),
    path: str | None = Query(default=None),
) -> MessageResponse:
    return file_service.upload_file(file, path)


@router.get("/download-link", response_model=DownloadLinkResponse, dependencies=[Depends(require_auth)])
def download_link(
    request: Request,
    path: str = Query(...),
) -> DownloadLinkResponse:
    return file_service.build_download_link(path, request)


@router.get("/download")
def download_file(
    path: str = Query(...),
    download_token: str | None = Query(default=None),
    authorization: str | None = Header(default=None),
    session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> FileResponse:
    target = file_service.resolve_existing_file(path)
    if not (
        is_request_authenticated(authorization, session_cookie)
        or file_service.validate_download_token(target, download_token)
    ):
        raise HTTPException(status_code=403, detail="download authorization required")
    return file_service.download_file(str(target))
