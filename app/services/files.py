from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import mimetypes
import os
import shutil
import stat
import subprocess
import time
from pathlib import Path
from urllib.parse import urlencode

from fastapi import HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse

from app.core.settings import SETTINGS
from app.models import (
    CreateDirectoryRequest,
    DownloadLinkResponse,
    FileEntry,
    FileListResponse,
    MessageResponse,
    RenameFileRequest,
)
from app.services.access import PRIVILEGED_HELPER_PATH, helper_available


FILE_LIST_CACHE_TTL = 2
DOWNLOAD_LINK_TTL_SECONDS = 120
WORKSPACE_BROWSE_MODE = "workspace"
SYSTEM_BROWSE_MODE = "system"
_directory_cache: dict[tuple[str, bool, str], tuple[float, FileListResponse]] = {}


def invalidate_file_cache() -> None:
    _directory_cache.clear()


def normalize_browse_mode(raw_value: str | None) -> str:
    if (raw_value or "").strip().lower() == SYSTEM_BROWSE_MODE:
        return SYSTEM_BROWSE_MODE
    return WORKSPACE_BROWSE_MODE


def readonly_system_roots() -> list[Path]:
    roots: list[Path] = []
    seen: set[str] = set()
    for raw_root in SETTINGS.system_readonly_paths:
        resolved = Path(raw_root).expanduser().resolve(strict=False)
        key = str(resolved)
        if key in seen:
            continue
        seen.add(key)
        roots.append(resolved)
    return roots


def readonly_system_root_strings() -> list[str]:
    return [str(path) for path in readonly_system_roots()]


def resolve_system_path(raw_path: str | None) -> tuple[Path, Path]:
    roots = readonly_system_roots()
    if not roots:
        raise HTTPException(status_code=400, detail="no readonly system paths are configured")

    candidate = Path(raw_path).expanduser() if raw_path else roots[0]
    if not candidate.is_absolute():
        raise HTTPException(status_code=400, detail="system path must be absolute")

    resolved = candidate.resolve(strict=False)
    for root in roots:
        try:
            resolved.relative_to(root)
            return resolved, root
        except ValueError:
            continue
        if resolved == root:
            return resolved, root

    raise HTTPException(status_code=400, detail="path is outside configured readonly system roots")


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


def ensure_workspace_mode(browse_mode: str | None) -> None:
    if normalize_browse_mode(browse_mode) != WORKSPACE_BROWSE_MODE:
        raise HTTPException(status_code=403, detail="system paths are readonly in the panel")


def permission_denied_error(target: Path) -> HTTPException:
    return HTTPException(
        status_code=403,
        detail=(
            f"service user cannot access {target}; "
            "adjust AGENT_ROOT, or run 'sudo file-panel grant-access <path>' "
            "to grant the filepanel user access to that directory"
        ),
    )


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _download_signature(payload: bytes) -> bytes:
    return hmac.new((SETTINGS.auth_token or "").encode("utf-8"), payload, hashlib.sha256).digest()


def run_privileged_helper_text(args: list[str], action: str, *, timeout_seconds: int = 30) -> str:
    if not helper_available():
        raise HTTPException(status_code=500, detail="privileged helper is not installed")

    try:
        result = subprocess.run(
            ["sudo", "-n", PRIVILEGED_HELPER_PATH, *args],
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail=f"timed out while attempting to {action}") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to {action}: {exc}") from exc

    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"failed to {action}"
        raise HTTPException(status_code=500, detail=detail)
    return result.stdout


def run_privileged_helper_bytes(args: list[str], action: str, *, timeout_seconds: int = 30) -> bytes:
    if not helper_available():
        raise HTTPException(status_code=500, detail="privileged helper is not installed")

    try:
        result = subprocess.run(
            ["sudo", "-n", PRIVILEGED_HELPER_PATH, *args],
            capture_output=True,
            text=False,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail=f"timed out while attempting to {action}") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to {action}: {exc}") from exc

    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip() or "failed to complete helper action"
        raise HTTPException(status_code=500, detail=detail)
    return result.stdout


def resolve_existing_file(path: str) -> Path:
    target = resolve_path(path)
    try:
        if not target.exists() or not target.is_file():
            raise HTTPException(status_code=404, detail="file not found")
    except PermissionError as exc:
        raise permission_denied_error(target.parent) from exc
    return target


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
        raise permission_denied_error(target) from exc


def list_system_entries(target: Path, *, show_hidden: bool) -> list[FileEntry]:
    raw_payload = run_privileged_helper_text(
        ["readonly-list-json", str(target), "true" if show_hidden else "false"],
        "list readonly system path",
        timeout_seconds=60,
    )
    try:
        payload = json.loads(raw_payload)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail="readonly helper returned invalid JSON") from exc

    if not isinstance(payload, dict) or not isinstance(payload.get("entries"), list):
        raise HTTPException(status_code=500, detail="readonly helper returned an unexpected payload")

    return [FileEntry.model_validate(entry) for entry in payload["entries"]]


def build_workspace_file_list(path: str | None, show_hidden: bool) -> FileListResponse:
    current_path = resolve_path(path)
    try:
        if not current_path.exists():
            raise HTTPException(status_code=404, detail="path not found")
        if not current_path.is_dir():
            raise HTTPException(status_code=400, detail="path is not a directory")
    except PermissionError as exc:
        raise permission_denied_error(current_path) from exc

    cache_key = (WORKSPACE_BROWSE_MODE, str(current_path), show_hidden)
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
        browse_mode=WORKSPACE_BROWSE_MODE,
        read_only=False,
        system_roots=readonly_system_root_strings(),
        current_path=str(current_path),
        root_path=str(SETTINGS.root_path),
        parent_path=parent_path,
        show_hidden=show_hidden,
        entries=list_directory_entries(current_path, show_hidden=show_hidden),
    )
    _directory_cache[cache_key] = (time.time(), response)
    return response


def build_system_file_list(path: str | None, show_hidden: bool) -> FileListResponse:
    current_path, root_path = resolve_system_path(path)
    cache_key = (SYSTEM_BROWSE_MODE, str(current_path), show_hidden)
    cached = _directory_cache.get(cache_key)
    if cached and time.time() - cached[0] < FILE_LIST_CACHE_TTL:
        return cached[1]

    parent_path = None if current_path == root_path else str(current_path.parent)
    response = FileListResponse(
        browse_mode=SYSTEM_BROWSE_MODE,
        read_only=True,
        system_roots=readonly_system_root_strings(),
        current_path=str(current_path),
        root_path=str(root_path),
        parent_path=parent_path,
        show_hidden=show_hidden,
        entries=list_system_entries(current_path, show_hidden=show_hidden),
    )
    _directory_cache[cache_key] = (time.time(), response)
    return response


def build_file_list(path: str | None, show_hidden: bool, *, browse_mode: str | None = None) -> FileListResponse:
    normalized_mode = normalize_browse_mode(browse_mode)
    if normalized_mode == SYSTEM_BROWSE_MODE:
        return build_system_file_list(path, show_hidden)
    return build_workspace_file_list(path, show_hidden)


def create_directory(request: CreateDirectoryRequest) -> MessageResponse:
    ensure_workspace_mode(request.browse_mode)
    target = resolve_path(request.path)
    ensure_not_root(target)
    if target.exists():
        raise HTTPException(status_code=409, detail="directory already exists")
    try:
        target.mkdir(parents=False, exist_ok=False)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="parent directory not found") from exc
    except PermissionError as exc:
        raise permission_denied_error(target.parent) from exc
    invalidate_file_cache()
    return MessageResponse(message="directory created")


def delete_path(path: str, *, browse_mode: str | None = None) -> MessageResponse:
    ensure_workspace_mode(browse_mode)
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
        raise permission_denied_error(target) from exc

    invalidate_file_cache()
    return MessageResponse(message="deleted")


def rename_path(request: RenameFileRequest) -> MessageResponse:
    ensure_workspace_mode(request.browse_mode)
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
        raise permission_denied_error(old_path.parent) from exc

    invalidate_file_cache()
    return MessageResponse(message="renamed")


def upload_file(file: UploadFile, path: str | None, *, browse_mode: str | None = None) -> MessageResponse:
    ensure_workspace_mode(browse_mode)
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
        raise permission_denied_error(destination_dir) from exc
    finally:
        file.file.close()

    invalidate_file_cache()
    return MessageResponse(message="uploaded")


def build_download_token(path: str) -> str:
    if not SETTINGS.auth_token:
        return ""

    target = resolve_existing_file(path)
    payload = json.dumps(
        {
            "path": str(target),
            "exp": int(time.time()) + DOWNLOAD_LINK_TTL_SECONDS,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    signature = _download_signature(payload)
    return f"{_b64url_encode(payload)}.{_b64url_encode(signature)}"


def validate_download_token(target: Path, download_token: str | None) -> bool:
    if not SETTINGS.auth_token:
        return True
    if not download_token:
        return False

    try:
        encoded_payload, encoded_signature = download_token.split(".", 1)
        payload = _b64url_decode(encoded_payload)
        signature = _b64url_decode(encoded_signature)
        parsed_payload = json.loads(payload.decode("utf-8"))
    except (ValueError, TypeError, binascii.Error, UnicodeDecodeError, json.JSONDecodeError):
        return False

    expected_signature = _download_signature(payload)
    if not hmac.compare_digest(signature, expected_signature):
        return False

    return (
        parsed_payload.get("path") == str(target)
        and int(parsed_payload.get("exp", 0)) >= int(time.time())
    )


def build_download_link(path: str, request: Request, *, browse_mode: str | None = None) -> DownloadLinkResponse:
    normalized_mode = normalize_browse_mode(browse_mode)
    params = {"path": path}
    if normalized_mode == SYSTEM_BROWSE_MODE:
        params["browse_mode"] = SYSTEM_BROWSE_MODE
        download_url = f"{request.url_for('download_file')}?{urlencode(params)}"
        return DownloadLinkResponse(url=download_url, expires_in_seconds=0)

    target = resolve_existing_file(path)
    if SETTINGS.auth_token:
        params["download_token"] = build_download_token(str(target))

    download_url = f"{request.url_for('download_file')}?{urlencode(params)}"
    return DownloadLinkResponse(
        url=download_url,
        expires_in_seconds=DOWNLOAD_LINK_TTL_SECONDS if SETTINGS.auth_token else 0,
    )


def download_file(path: str, *, browse_mode: str | None = None) -> FileResponse | Response:
    normalized_mode = normalize_browse_mode(browse_mode)
    if normalized_mode == SYSTEM_BROWSE_MODE:
        target, _ = resolve_system_path(path)
        content = run_privileged_helper_bytes(
            ["readonly-read-file", str(target)],
            "read readonly system file",
            timeout_seconds=120,
        )
        media_type, _ = mimetypes.guess_type(target.name)
        safe_name = target.name.replace('"', "")
        return Response(
            content=content,
            media_type=media_type or "application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{safe_name}"'},
        )

    target = resolve_existing_file(path)
    media_type, _ = mimetypes.guess_type(target.name)
    return FileResponse(
        path=target,
        media_type=media_type or "application/octet-stream",
        filename=target.name,
    )
