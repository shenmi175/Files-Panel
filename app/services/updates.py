from __future__ import annotations

import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from app.core import storage
from app.core.settings import SETTINGS
from app.core.version import APP_VERSION, read_project_version
from app.models import (
    BatchUpdateNodeResult,
    BatchUpdateTriggerResponse,
    UpdateStatusResponse,
    UpdateTriggerRequest,
    UpdateTriggerResponse,
)
from app.services.access import helper_available, run_privileged_helper
from app.services.common import command_available
from app.services.remote_nodes import remote_json_request


UPDATE_STATUS_FILE_NAME = "update-status.json"
UPDATE_LOG_FILE_NAME = "update.log"
UPDATE_STATUS_RUNNING = {"scheduled", "running"}
GIT_TIMEOUT_SECONDS = 8
DEFAULT_REMOTE_VERSION_REF = "origin/main"


def _status_file_path() -> Path:
    return SETTINGS.state_dir / UPDATE_STATUS_FILE_NAME


def _log_file_path() -> Path:
    return SETTINGS.state_dir / UPDATE_LOG_FILE_NAME


def _source_dir() -> Path | None:
    raw_value = (os.getenv("FILE_PANEL_SOURCE_DIR") or "").strip()
    if raw_value:
        return Path(raw_value).expanduser()
    return None


def _is_project_dir(path: Path | None) -> bool:
    if path is None:
        return False
    return (
        path.is_dir()
        and (path / "app").is_dir()
        and (path / "static").is_dir()
        and (path / "scripts").is_dir()
        and (path / "requirements.txt").is_file()
    )


def _load_status_payload() -> dict[str, object]:
    status_path = _status_file_path()
    if not status_path.is_file():
        return {}
    try:
        return json.loads(status_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _run_git(source_dir: Path, *args: str) -> str | None:
    try:
        completed = subprocess.run(
            ["git", "-C", str(source_dir), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=GIT_TIMEOUT_SECONDS,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    output = completed.stdout.strip()
    return output or None


def _remote_version_ref(source_dir: Path) -> str:
    ref = _run_git(source_dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    return ref or DEFAULT_REMOTE_VERSION_REF


def _version_sort_key(raw_version: str | None) -> tuple[tuple[int, object], ...]:
    if not raw_version:
        return tuple()

    parts: list[tuple[int, object]] = []
    for token in re.findall(r"\d+|[A-Za-z]+", raw_version):
        if token.isdigit():
            parts.append((0, int(token)))
        else:
            parts.append((1, token.lower()))
    return tuple(parts)


def _latest_available_version(
    source_dir: Path | None,
    *,
    project_dir_valid: bool,
    git_available: bool,
    git_repo: bool,
) -> tuple[str | None, str | None]:
    if not project_dir_valid or source_dir is None:
        return None, None

    local_source_version = read_project_version(source_dir)
    if not git_available or not git_repo:
        return local_source_version, None

    if _run_git(source_dir, "remote", "get-url", "origin") is None:
        return local_source_version, None

    if _run_git(source_dir, "fetch", "--quiet", "origin") is None:
        return local_source_version, None

    remote_ref = _remote_version_ref(source_dir)
    remote_version = _run_git(source_dir, "show", f"{remote_ref}:VERSION")
    if remote_version:
        return remote_version.strip(), _utc_timestamp()
    return local_source_version, _utc_timestamp()


def build_update_status() -> UpdateStatusResponse:
    source_dir = _source_dir()
    source_dir_exists = bool(source_dir and source_dir.exists())
    project_dir_valid = _is_project_dir(source_dir)
    git_available = command_available("git")
    git_repo = bool(source_dir and (source_dir / ".git").exists())
    status_payload = _load_status_payload()
    current_version = read_project_version()
    latest_version, latest_checked_at = _latest_available_version(
        source_dir,
        project_dir_valid=project_dir_valid,
        git_available=git_available,
        git_repo=git_repo,
    )
    status = str(status_payload.get("status") or "idle").strip().lower() or "idle"
    if status in UPDATE_STATUS_RUNNING and not helper_available():
        status = "failed"

    update_available = False
    if current_version and latest_version:
        current_key = _version_sort_key(current_version)
        latest_key = _version_sort_key(latest_version)
        if current_key and latest_key:
            update_available = latest_key > current_key
        else:
            update_available = latest_version != current_version

    return UpdateStatusResponse(
        role=SETTINGS.role,
        source_dir=str(source_dir) if source_dir else None,
        source_dir_exists=source_dir_exists,
        project_dir_valid=project_dir_valid,
        git_available=git_available,
        git_repo=git_repo,
        auto_update_available=helper_available() and project_dir_valid,
        current_version=current_version or APP_VERSION,
        latest_version=latest_version,
        update_available=update_available,
        latest_checked_at=latest_checked_at,
        status=status,
        mode=str(status_payload.get("mode")) if status_payload.get("mode") else None,
        pull_latest=bool(status_payload.get("pull_latest")) if "pull_latest" in status_payload else None,
        started_at=str(status_payload.get("started_at")) if status_payload.get("started_at") else None,
        finished_at=str(status_payload.get("finished_at")) if status_payload.get("finished_at") else None,
        message=str(status_payload.get("message")) if status_payload.get("message") else None,
        log_path=str(status_payload.get("log_path")) if status_payload.get("log_path") else str(_log_file_path()),
    )


def schedule_update(request: UpdateTriggerRequest) -> UpdateTriggerResponse:
    status = build_update_status()
    if status.status in UPDATE_STATUS_RUNNING:
        raise HTTPException(status_code=409, detail="an update is already running on this node")
    if not status.auto_update_available:
        raise HTTPException(
            status_code=400,
            detail="automatic update is unavailable on this node; reinstall once from the source repository first",
        )
    if request.pull_latest and not status.git_repo:
        raise HTTPException(
            status_code=400,
            detail="this node has no linked git repository; disable pull-latest or reinstall from a git checkout first",
        )

    run_privileged_helper(
        [
            "schedule-update",
            request.mode,
            "1" if request.pull_latest else "0",
        ],
        "schedule automatic update",
        timeout_seconds=15,
    )

    next_status = build_update_status()
    return UpdateTriggerResponse(
        message="update scheduled",
        scheduled=True,
        status=next_status,
    )


def schedule_all_remote_updates(request: UpdateTriggerRequest) -> BatchUpdateTriggerResponse:
    if SETTINGS.role != "manager":
        raise HTTPException(status_code=400, detail="batch node update is only available on the manager")

    remote_servers = [
        payload
        for payload in storage.list_servers()
        if not bool(payload.get("is_local")) and bool(payload.get("enabled"))
    ]
    if not remote_servers:
        raise HTTPException(status_code=400, detail="no enabled remote nodes are configured")

    results: list[BatchUpdateNodeResult] = []
    scheduled_nodes = 0
    failed_nodes = 0

    for server in remote_servers:
        server_id = int(server["id"])
        server_name = str(server["name"])
        try:
            remote_payload = remote_json_request(
                server_id,
                method="POST",
                path="/api/update",
                json_body=request.model_dump(),
            )
            message = str(remote_payload.get("message") or "update scheduled")
            scheduled = bool(remote_payload.get("scheduled"))
        except HTTPException as exc:
            scheduled = False
            detail = exc.detail
            if isinstance(detail, str):
                message = detail
            else:
                message = "update request failed"

        if scheduled:
            scheduled_nodes += 1
        else:
            failed_nodes += 1

        results.append(
            BatchUpdateNodeResult(
                server_id=server_id,
                server_name=server_name,
                scheduled=scheduled,
                message=message,
            )
        )

    return BatchUpdateTriggerResponse(
        message="batch update scheduled" if scheduled_nodes else "batch update failed",
        mode=request.mode,
        pull_latest=request.pull_latest,
        total_nodes=len(remote_servers),
        scheduled_nodes=scheduled_nodes,
        failed_nodes=failed_nodes,
        results=results,
    )
