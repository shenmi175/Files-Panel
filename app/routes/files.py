from __future__ import annotations

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import FileResponse

from app.core.auth import require_auth
from app.models import CreateDirectoryRequest, FileListResponse, MessageResponse, RenameFileRequest
from app.services import files as file_service


router = APIRouter(prefix="/api/files", tags=["files"], dependencies=[Depends(require_auth)])


@router.get("", response_model=FileListResponse)
async def list_files(
    path: str | None = Query(default=None),
    show_hidden: bool = Query(default=False),
) -> FileListResponse:
    return file_service.build_file_list(path, show_hidden)


@router.post("/mkdir", response_model=MessageResponse)
async def create_directory(request: CreateDirectoryRequest) -> MessageResponse:
    return file_service.create_directory(request)


@router.delete("", response_model=MessageResponse)
async def delete_path(path: str = Query(...)) -> MessageResponse:
    return file_service.delete_path(path)


@router.post("/rename", response_model=MessageResponse)
async def rename_path(request: RenameFileRequest) -> MessageResponse:
    return file_service.rename_path(request)


@router.post("/upload", response_model=MessageResponse)
async def upload_file(
    file: UploadFile = File(...),
    path: str | None = Query(default=None),
) -> MessageResponse:
    return file_service.upload_file(file, path)


@router.get("/download")
async def download_file(path: str = Query(...)) -> FileResponse:
    return file_service.download_file(path)
