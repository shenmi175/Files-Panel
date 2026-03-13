from __future__ import annotations

import mimetypes
import os
import shutil
import stat
import time
from pathlib import Path

from fastapi import HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.core.settings import SETTINGS
from app.models import (
    CreateDirectoryRequest,
    FileEntry,
    FileListResponse,
    MessageResponse,
    RenameFileRequest,
)


FILE_LIST_CACHE_TTL = 2
_directory_cache: dict[tuple[str, bool], tuple[float, FileListResponse]] = {}


def invalidate_file_cache() -> None:
    _directory_cache.clear()


def resolve_path(raw_path: str | None) -> Path:
    if raw_path:
        incoming = Path(raw_path).expanduser()
        candidate = incoming if incoming.is_absolute() else SETTINGS.root_path / incoming
    else:
        candidate = SETTINGS.root_path

    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(SETTINGS.root_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="path escapes agent root") from exc
    return resolved


def ensure_not_root(target: Path) -> None:
    if target == SETTINGS.root_path:
        raise HTTPException(status_code=400, detail="operation is not allowed on agent root")


def file_type_for(path: Path) -> str:
    if path.is_symlink():
        return "symlink"
    if path.is_dir():
        return "directory"
    if path.is_file():
        return "file"
    return "other"


def list_directory_entries(target: Path, *, show_hidden: bool) -> list[FileEntry]:
    try:
        entries: list[FileEntry] = []
        with os.scandir(target) as iterator:
            for entry in iterator:
                if not show_hidden and entry.name.startswith("."):
                    continue
                entry_path = Path(entry.path)
                info = entry.stat(follow_symlinks=False)
                entries.append(
                    FileEntry(
                        name=entry.name,
                        path=str(entry_path),
                        file_type=file_type_for(entry_path),
                        size=info.st_size,
                        mode=stat.filemode(info.st_mode),
                        modified_epoch=int(info.st_mtime),
                    )
                )
        entries.sort(key=lambda item: (item.file_type != "directory", item.name.lower()))
        return entries
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="directory not found") from exc
    except NotADirectoryError as exc:
        raise HTTPException(status_code=400, detail="path is not a directory") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="permission denied") from exc


def build_file_list(path: str | None, show_hidden: bool) -> FileListResponse:
    current_path = resolve_path(path)
    if not current_path.exists():
        raise HTTPException(status_code=404, detail="path not found")
    if not current_path.is_dir():
        raise HTTPException(status_code=400, detail="path is not a directory")

    cache_key = (str(current_path), show_hidden)
    cached = _directory_cache.get(cache_key)
    if cached and time.time() - cached[0] < FILE_LIST_CACHE_TTL:
        return cached[1]

    try:
        parent_candidate = current_path.parent.resolve(strict=False)
        parent_candidate.relative_to(SETTINGS.root_path)
        parent_path = None if current_path == SETTINGS.root_path else str(parent_candidate)
    except ValueError:
        parent_path = None

    response = FileListResponse(
        current_path=str(current_path),
        root_path=str(SETTINGS.root_path),
        parent_path=parent_path,
        show_hidden=show_hidden,
        entries=list_directory_entries(current_path, show_hidden=show_hidden),
    )
    _directory_cache[cache_key] = (time.time(), response)
    return response


def create_directory(request: CreateDirectoryRequest) -> MessageResponse:
    target = resolve_path(request.path)
    ensure_not_root(target)
    if target.exists():
        raise HTTPException(status_code=409, detail="directory already exists")
    try:
        target.mkdir(parents=False, exist_ok=False)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="parent directory not found") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="permission denied") from exc
    invalidate_file_cache()
    return MessageResponse(message="directory created")


def delete_path(path: str) -> MessageResponse:
    target = resolve_path(path)
    ensure_not_root(target)
    if not target.exists() and not target.is_symlink():
        raise HTTPException(status_code=404, detail="path not found")

    try:
        if target.is_symlink() or target.is_file():
            target.unlink()
        elif target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink(missing_ok=False)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="permission denied") from exc

    invalidate_file_cache()
    return MessageResponse(message="deleted")


def rename_path(request: RenameFileRequest) -> MessageResponse:
    old_path = resolve_path(request.old_path)
    new_path = resolve_path(request.new_path)
    ensure_not_root(old_path)
    ensure_not_root(new_path)
    if not old_path.exists() and not old_path.is_symlink():
        raise HTTPException(status_code=404, detail="source path not found")
    if new_path.exists():
        raise HTTPException(status_code=409, detail="target path already exists")

    try:
        old_path.rename(new_path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="target parent directory not found") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="permission denied") from exc

    invalidate_file_cache()
    return MessageResponse(message="renamed")


def upload_file(file: UploadFile, path: str | None) -> MessageResponse:
    destination_dir = resolve_path(path)
    if not destination_dir.exists():
        raise HTTPException(status_code=404, detail="destination directory not found")
    if not destination_dir.is_dir():
        raise HTTPException(status_code=400, detail="destination is not a directory")

    file_name = Path(file.filename or "").name
    if not file_name:
        raise HTTPException(status_code=400, detail="upload requires a filename")

    target_path = destination_dir / file_name
    if target_path.exists():
        raise HTTPException(status_code=409, detail="file already exists")

    try:
        with target_path.open("wb") as handle:
            file.file.seek(0)
            shutil.copyfileobj(file.file, handle)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="permission denied") from exc
    finally:
        file.file.close()

    invalidate_file_cache()
    return MessageResponse(message="uploaded")


def download_file(path: str) -> FileResponse:
    target = resolve_path(path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")

    media_type, _ = mimetypes.guess_type(target.name)
    return FileResponse(
        path=target,
        media_type=media_type or "application/octet-stream",
        filename=target.name,
    )
