from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from app.core.settings import SETTINGS, normalize_resource_sample_interval


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def human_bytes(value: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB", "PB"]
    size = float(value)
    for unit in units:
        if size < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{int(size)} {unit}"
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{int(value)} B"


def format_uptime(seconds: float) -> str:
    remaining = int(seconds)
    days, remaining = divmod(remaining, 86400)
    hours, remaining = divmod(remaining, 3600)
    minutes, _ = divmod(remaining, 60)
    parts: list[str] = []
    if days:
        parts.append(f"{days}d")
    if hours:
        parts.append(f"{hours}h")
    if minutes or not parts:
        parts.append(f"{minutes}m")
    return "up " + " ".join(parts)


def command_available(name: str) -> bool:
    return shutil.which(name) is not None


def env_flag(value: str | None, *, default: bool) -> bool:
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no"}


def is_public_bind(host: str) -> bool:
    return host not in {"127.0.0.1", "::1", "localhost"}


def normalize_existing_directory(raw_path: str) -> Path:
    target = Path(raw_path).expanduser().resolve(strict=False)
    if not target.exists() or not target.is_dir():
        raise HTTPException(status_code=400, detail="agent root must be an existing directory")
    return target


def runtime_restart_needed(env_values: dict[str, str]) -> bool:
    desired_root = Path(env_values.get("AGENT_ROOT", str(SETTINGS.root_path))).expanduser().resolve(
        strict=False
    )
    desired_allow_self_restart = env_flag(
        env_values.get("ALLOW_SELF_RESTART"),
        default=SETTINGS.allow_self_restart,
    )
    desired_host = env_values.get("HOST", SETTINGS.host)
    desired_port = int(env_values.get("PORT", SETTINGS.port))
    desired_name = env_values.get("AGENT_NAME", SETTINGS.agent_name)
    desired_token = (env_values.get("AGENT_TOKEN", SETTINGS.auth_token or "") or "").strip() or None
    desired_sample_interval = normalize_resource_sample_interval(
        env_values.get("RESOURCE_SAMPLE_INTERVAL"),
        fallback=SETTINGS.sample_interval_seconds,
    )
    return any(
        [
            desired_host != SETTINGS.host,
            desired_port != SETTINGS.port,
            desired_name != SETTINGS.agent_name,
            desired_root != SETTINGS.root_path,
            desired_token != SETTINGS.auth_token,
            desired_sample_interval != SETTINGS.sample_interval_seconds,
            desired_allow_self_restart != SETTINGS.allow_self_restart,
        ]
    )
