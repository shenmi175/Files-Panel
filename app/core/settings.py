from __future__ import annotations

import os
import re
import socket
from dataclasses import dataclass
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent.parent.parent
STATIC_DIR = BASE_DIR / "static"
ACCESS_STATE_FILE = "access.json"
RESOURCE_HISTORY_MAX_POINTS = 96
DEFAULT_RESOURCE_SAMPLE_INTERVAL = 15
RESOURCE_SAMPLE_INTERVAL_CHOICES = (2, 5, 10, 15)
RESOURCE_SNAPSHOT_CACHE_TTL = 3
DOMAIN_PATTERN = re.compile(
    r"^(?=.{1,253}$)(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$"
)


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    agent_name: str
    root_path: Path
    auth_token: str | None
    sample_interval_seconds: int
    env_file_path: Path
    state_dir: Path
    nginx_sites_available_dir: Path
    nginx_sites_enabled_dir: Path
    agent_service_name: str | None
    nginx_service_name: str | None
    certbot_email: str | None
    allow_self_restart: bool


def normalize_resource_sample_interval(
    raw_value: str | int | None,
    *,
    fallback: int = DEFAULT_RESOURCE_SAMPLE_INTERVAL,
) -> int:
    if raw_value in {None, ""}:
        return fallback
    try:
        candidate = int(raw_value)
    except (TypeError, ValueError):
        return fallback
    if candidate not in RESOURCE_SAMPLE_INTERVAL_CHOICES:
        return fallback
    return candidate


def load_settings() -> Settings:
    host = os.getenv("HOST", "127.0.0.1").strip() or "127.0.0.1"
    port = int(os.getenv("PORT", "3000"))
    root_path = Path(os.getenv("AGENT_ROOT", "/")).expanduser().resolve(strict=False)
    if not root_path.exists() or not root_path.is_dir():
        raise RuntimeError(f"AGENT_ROOT is not a directory: {root_path}")

    auth_token = os.getenv("AGENT_TOKEN", "").strip() or None
    allow_self_restart = os.getenv("ALLOW_SELF_RESTART", "1").strip().lower() not in {
        "0",
        "false",
        "no",
    }
    return Settings(
        host=host,
        port=port,
        agent_name=os.getenv("AGENT_NAME", socket.gethostname()).strip() or socket.gethostname(),
        root_path=root_path,
        auth_token=auth_token,
        sample_interval_seconds=normalize_resource_sample_interval(
            os.getenv("RESOURCE_SAMPLE_INTERVAL"),
        ),
        env_file_path=Path(os.getenv("ENV_FILE_PATH", "/etc/files-agent/files-agent.env")).expanduser(),
        state_dir=Path(os.getenv("STATE_DIR", "/var/lib/files-agent")).expanduser(),
        nginx_sites_available_dir=Path(
            os.getenv("NGINX_SITES_AVAILABLE_DIR", "/etc/nginx/sites-available")
        ).expanduser(),
        nginx_sites_enabled_dir=Path(
            os.getenv("NGINX_SITES_ENABLED_DIR", "/etc/nginx/sites-enabled")
        ).expanduser(),
        agent_service_name=os.getenv("AGENT_SERVICE_NAME", "files-agent").strip() or None,
        nginx_service_name=os.getenv("NGINX_SERVICE_NAME", "nginx").strip() or None,
        certbot_email=os.getenv("CERTBOT_EMAIL", "").strip() or None,
        allow_self_restart=allow_self_restart,
    )


SETTINGS = load_settings()
