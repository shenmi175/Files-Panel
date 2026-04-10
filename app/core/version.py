from __future__ import annotations

from pathlib import Path


DEFAULT_APP_VERSION = "1.1.0"
VERSION_FILE_NAME = "VERSION"
RUNTIME_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_UPDATE_CHANNEL = "main"
UPDATE_CHANNEL_CHOICES = ("stable", "rc", "main")


def _normalize_version(raw_value: str | None) -> str | None:
    if raw_value is None:
        return None
    value = raw_value.strip()
    return value or None


def normalize_update_channel(
    raw_value: str | None,
    *,
    fallback: str = DEFAULT_UPDATE_CHANNEL,
) -> str:
    if raw_value is None:
        return fallback
    candidate = raw_value.strip().lower()
    if candidate in UPDATE_CHANNEL_CHOICES:
        return candidate
    return fallback


def read_project_version(project_dir: Path | None = None) -> str:
    base_dir = project_dir or RUNTIME_ROOT
    version_path = base_dir / VERSION_FILE_NAME
    try:
        value = _normalize_version(version_path.read_text(encoding="utf-8"))
    except OSError:
        value = None
    return value or DEFAULT_APP_VERSION


APP_VERSION = read_project_version()
