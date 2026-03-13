from __future__ import annotations

import json
import subprocess
from contextlib import suppress
from datetime import datetime, timezone

from app.core.settings import SETTINGS
from app.models import DockerContainerSummary, DockerStatusResponse, LogEntry, LogsResponse
from app.services.common import command_available, utc_now


COMMAND_TIMEOUT_SECONDS = 8
MAX_LOG_LINES = 200
ALLOWED_LOG_LEVELS = {"info", "warning", "error"}


def run_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"command not found: {command[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"command timed out: {' '.join(command)}") from exc
    except OSError as exc:
        raise RuntimeError(str(exc)) from exc


def parse_json_lines(raw_text: str) -> list[dict[str, object]]:
    items: list[dict[str, object]] = []
    for raw_line in raw_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        with suppress(json.JSONDecodeError):
            parsed = json.loads(line)
            if isinstance(parsed, dict):
                items.append(parsed)
    return items


def docker_message(detail: str | None) -> str:
    if not detail:
        return "docker 当前不可用"
    return detail.strip().splitlines()[-1]


def journal_timestamp_to_iso(raw_value: object) -> str:
    try:
        microseconds = int(str(raw_value))
        return datetime.fromtimestamp(microseconds / 1_000_000, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return utc_now()


def normalize_log_level(level: str | None) -> str:
    normalized = (level or "info").strip().lower()
    if normalized not in ALLOWED_LOG_LEVELS:
        return "info"
    return normalized


def priority_to_level(priority: object) -> str:
    try:
        numeric = int(str(priority))
    except (TypeError, ValueError):
        return "info"

    if numeric <= 3:
        return "error"
    if numeric == 4:
        return "warning"
    return "info"


def log_matches_level(priority: object, level_filter: str) -> bool:
    return priority_to_level(priority) == level_filter


def journal_priority_range(level_filter: str) -> str:
    if level_filter == "error":
        return "0..3"
    if level_filter == "warning":
        return "4..4"
    return "5..7"


def get_docker_status() -> DockerStatusResponse:
    if not command_available("docker"):
        return DockerStatusResponse(
            available=False,
            running_count=0,
            message="未安装 docker",
            containers=[],
        )

    try:
        ps_result = run_command(["docker", "ps", "--format", "{{json .}}"])
    except RuntimeError as exc:
        return DockerStatusResponse(
            available=False,
            running_count=0,
            message=docker_message(str(exc)),
            containers=[],
        )

    if ps_result.returncode != 0:
        return DockerStatusResponse(
            available=False,
            running_count=0,
            message=docker_message(ps_result.stderr or ps_result.stdout),
            containers=[],
        )

    ps_items = parse_json_lines(ps_result.stdout)
    if not ps_items:
        return DockerStatusResponse(
            available=True,
            running_count=0,
            message="docker 已安装，当前没有运行中的容器",
            containers=[],
        )

    stats_by_key: dict[str, dict[str, object]] = {}
    stats_message: str | None = None
    try:
        stats_result = run_command(["docker", "stats", "--no-stream", "--format", "{{json .}}"])
        if stats_result.returncode == 0:
            for item in parse_json_lines(stats_result.stdout):
                for key in (item.get("Container"), item.get("ID"), item.get("Name")):
                    if key:
                        stats_by_key[str(key)] = item
        else:
            stats_message = docker_message(stats_result.stderr or stats_result.stdout)
    except RuntimeError as exc:
        stats_message = docker_message(str(exc))

    containers: list[DockerContainerSummary] = []
    for item in ps_items:
        container_id = str(item.get("ID") or "")
        container_name = str(item.get("Names") or item.get("Name") or container_id)
        stats = stats_by_key.get(container_id) or stats_by_key.get(container_name) or {}
        containers.append(
            DockerContainerSummary(
                id=container_id,
                name=container_name,
                image=str(item.get("Image") or "-"),
                state=str(item.get("State") or "-"),
                status=str(item.get("Status") or "-"),
                ports=str(item.get("Ports") or "-"),
                running_for=str(item.get("RunningFor") or "-"),
                cpu_percent=str(stats.get("CPUPerc")) if stats.get("CPUPerc") is not None else None,
                memory_usage=str(stats.get("MemUsage")) if stats.get("MemUsage") is not None else None,
                memory_percent=str(stats.get("MemPerc")) if stats.get("MemPerc") is not None else None,
                network_io=str(stats.get("NetIO")) if stats.get("NetIO") is not None else None,
                block_io=str(stats.get("BlockIO")) if stats.get("BlockIO") is not None else None,
                pids=str(stats.get("PIDs")) if stats.get("PIDs") is not None else None,
            )
        )

    containers.sort(key=lambda item: item.name.lower())
    return DockerStatusResponse(
        available=True,
        running_count=len(containers),
        message=stats_message,
        containers=containers,
    )


def get_runtime_logs(
    *,
    limit: int = MAX_LOG_LINES,
    cursor: str | None = None,
    level: str = "info",
) -> LogsResponse:
    service_name = SETTINGS.agent_service_name
    level_filter = normalize_log_level(level)
    safe_limit = max(20, min(limit, MAX_LOG_LINES))
    if not service_name:
        return LogsResponse(
            available=False,
            service_name=None,
            cursor=None,
            level_filter=level_filter,
            message="未配置 agent service 名称",
            lines=[],
        )

    if not command_available("journalctl"):
        return LogsResponse(
            available=False,
            service_name=service_name,
            cursor=None,
            level_filter=level_filter,
            message="系统未安装 journalctl",
            lines=[],
        )

    command = [
        "journalctl",
        "-u",
        service_name,
        "--no-pager",
        "-o",
        "json",
        "--priority",
        journal_priority_range(level_filter),
    ]
    if cursor:
        command.extend(["--after-cursor", cursor])
    else:
        command.extend(["-n", str(safe_limit)])

    try:
        result = run_command(command)
    except RuntimeError as exc:
        return LogsResponse(
            available=False,
            service_name=service_name,
            cursor=cursor,
            level_filter=level_filter,
            message=str(exc),
            lines=[],
        )

    if result.returncode != 0:
        return LogsResponse(
            available=False,
            service_name=service_name,
            cursor=cursor,
            level_filter=level_filter,
            message=(result.stderr or result.stdout).strip() or "读取日志失败",
            lines=[],
        )

    entries: list[LogEntry] = []
    next_cursor = cursor
    for item in parse_json_lines(result.stdout):
        message = str(item.get("MESSAGE") or "").rstrip()
        if not message:
            continue

        current_cursor = str(item.get("__CURSOR")) if item.get("__CURSOR") else None
        if current_cursor:
            next_cursor = current_cursor

        priority = item.get("PRIORITY")
        if not log_matches_level(priority, level_filter):
            continue

        pid: int | None = None
        with suppress(TypeError, ValueError):
            pid = int(str(item.get("_PID")))

        entries.append(
            LogEntry(
                cursor=current_cursor,
                timestamp=journal_timestamp_to_iso(item.get("__REALTIME_TIMESTAMP")),
                message=message,
                level=priority_to_level(priority),
                priority=str(priority) if priority is not None else None,
                pid=pid,
                unit=str(item.get("_SYSTEMD_UNIT") or item.get("SYSLOG_IDENTIFIER") or service_name),
            )
        )

    if len(entries) > safe_limit:
        entries = entries[-safe_limit:]
        next_cursor = entries[-1].cursor or next_cursor

    return LogsResponse(
        available=True,
        service_name=service_name,
        cursor=next_cursor,
        level_filter=level_filter,
        message=None if entries else f"{level_filter} 级别暂无新的日志",
        lines=entries,
    )
