from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import pwd
import re
import secrets
import shlex
import shutil
import socket
import stat
import subprocess
import time
from collections import deque
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import psutil
import uvicorn
from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
ACCESS_STATE_FILE = "access.json"
RESOURCE_HISTORY_MAX_POINTS = 96
RESOURCE_SAMPLE_INTERVAL = 15
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
    env_file_path: Path
    state_dir: Path
    nginx_sites_available_dir: Path
    nginx_sites_enabled_dir: Path
    agent_service_name: str | None
    nginx_service_name: str | None
    certbot_email: str | None
    allow_self_restart: bool


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


class HealthResponse(BaseModel):
    status: str
    timestamp: str
    auth_enabled: bool


class AgentInfo(BaseModel):
    agent_name: str
    hostname: str
    current_user: str
    root_path: str
    auth_enabled: bool


class AccessStatus(BaseModel):
    current_bind_host: str
    current_bind_port: int
    desired_bind_host: str
    desired_bind_port: int
    public_ip_access_enabled: bool
    domain: str | None
    public_url: str | None
    nginx_available: bool
    nginx_running: bool
    certbot_available: bool
    https_enabled: bool
    token_configured: bool
    restart_pending: bool


class DomainSetupRequest(BaseModel):
    domain: str


class DomainSetupResponse(BaseModel):
    message: str
    public_url: str
    desired_bind_host: str
    https_enabled: bool
    restart_scheduled: bool


class LoadAverage(BaseModel):
    one: float
    five: float
    fifteen: float


class MemoryStats(BaseModel):
    total_mb: int
    used_mb: int
    free_mb: int
    available_mb: int
    used_percent: float


class DiskStats(BaseModel):
    total: str
    used: str
    available: str
    used_percent: float
    mount_point: str


class ResourceSnapshot(BaseModel):
    hostname: str
    uptime: str
    cpu_count: int
    load_ratio_percent: float
    load_average: LoadAverage
    memory: MemoryStats
    root_disk: DiskStats


class ResourceHistoryPoint(BaseModel):
    timestamp: str
    memory_used_percent: float
    disk_used_percent: float
    load_ratio_percent: float


class ResourceHistoryResponse(BaseModel):
    interval_seconds: int
    points: list[ResourceHistoryPoint]


class FileEntry(BaseModel):
    name: str
    path: str
    file_type: str
    size: int
    mode: str
    modified_epoch: int


class FileListResponse(BaseModel):
    current_path: str
    root_path: str
    parent_path: str | None
    show_hidden: bool
    entries: list[FileEntry]


class ConfigResponse(BaseModel):
    agent_name: str
    agent_root: str
    port: int
    allow_public_ip: bool
    certbot_email: str | None
    allow_self_restart: bool
    public_domain: str | None
    token_configured: bool
    auth_enabled: bool
    current_bind_host: str
    current_bind_port: int
    desired_bind_host: str
    desired_bind_port: int
    restart_pending: bool


class ConfigUpdateRequest(BaseModel):
    agent_name: str = Field(min_length=1, max_length=120)
    agent_root: str = Field(min_length=1, max_length=2048)
    port: int = Field(ge=1, le=65535)
    allow_public_ip: bool
    certbot_email: str | None = Field(default=None, max_length=254)
    allow_self_restart: bool


class ConfigUpdateResponse(BaseModel):
    message: str
    restart_required: bool
    restart_scheduled: bool
    config: ConfigResponse


class RenameFileRequest(BaseModel):
    old_path: str
    new_path: str


class CreateDirectoryRequest(BaseModel):
    path: str


class MessageResponse(BaseModel):
    message: str


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def require_auth(authorization: str | None = Header(default=None)) -> None:
    expected = SETTINGS.auth_token
    if not expected:
        return

    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token or not secrets.compare_digest(token, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing or invalid bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )


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
    desired_root = Path(env_values.get("AGENT_ROOT", str(SETTINGS.root_path))).expanduser().resolve(strict=False)
    desired_allow_self_restart = env_flag(
        env_values.get("ALLOW_SELF_RESTART"),
        default=SETTINGS.allow_self_restart,
    )
    desired_host = env_values.get("HOST", SETTINGS.host)
    desired_port = int(env_values.get("PORT", SETTINGS.port))
    desired_name = env_values.get("AGENT_NAME", SETTINGS.agent_name)
    return any(
        [
            desired_host != SETTINGS.host,
            desired_port != SETTINGS.port,
            desired_name != SETTINGS.agent_name,
            desired_root != SETTINGS.root_path,
            desired_allow_self_restart != SETTINGS.allow_self_restart,
        ]
    )


def default_env_values() -> dict[str, str]:
    return {
        "HOST": SETTINGS.host,
        "PORT": str(SETTINGS.port),
        "AGENT_NAME": SETTINGS.agent_name,
        "AGENT_ROOT": str(SETTINGS.root_path),
        "AGENT_TOKEN": SETTINGS.auth_token or "",
        "ENV_FILE_PATH": str(SETTINGS.env_file_path),
        "STATE_DIR": str(SETTINGS.state_dir),
        "NGINX_SITES_AVAILABLE_DIR": str(SETTINGS.nginx_sites_available_dir),
        "NGINX_SITES_ENABLED_DIR": str(SETTINGS.nginx_sites_enabled_dir),
        "AGENT_SERVICE_NAME": SETTINGS.agent_service_name or "",
        "NGINX_SERVICE_NAME": SETTINGS.nginx_service_name or "",
        "CERTBOT_EMAIL": SETTINGS.certbot_email or "",
        "ALLOW_SELF_RESTART": "1" if SETTINGS.allow_self_restart else "0",
    }


def read_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}

    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def write_env_file(path: Path, values: dict[str, str]) -> None:
    ordered_keys = [
        "HOST",
        "PORT",
        "AGENT_NAME",
        "AGENT_ROOT",
        "AGENT_TOKEN",
        "ENV_FILE_PATH",
        "STATE_DIR",
        "NGINX_SITES_AVAILABLE_DIR",
        "NGINX_SITES_ENABLED_DIR",
        "AGENT_SERVICE_NAME",
        "NGINX_SERVICE_NAME",
        "CERTBOT_EMAIL",
        "ALLOW_SELF_RESTART",
        "PUBLIC_DOMAIN",
    ]
    merged = {**default_env_values(), **values}
    lines = ["# Managed by Files Agent"]
    for key in ordered_keys:
        if key in merged and merged[key] != "":
            lines.append(f"{key}={merged[key]}")
    for key, value in merged.items():
        if key not in ordered_keys and value != "":
            lines.append(f"{key}={value}")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def access_state_path() -> Path:
    return SETTINGS.state_dir / ACCESS_STATE_FILE


def load_access_state() -> dict[str, object]:
    state_path = access_state_path()
    if not state_path.exists():
        return {}
    try:
        return json.loads(state_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_access_state(payload: dict[str, object]) -> None:
    SETTINGS.state_dir.mkdir(parents=True, exist_ok=True)
    access_state_path().write_text(json.dumps(payload, indent=2), encoding="utf-8")


def run_command(command: list[str], action: str) -> None:
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to {action}: {exc}") from exc

    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"failed to {action}"
        raise HTTPException(status_code=500, detail=detail)


def service_is_active(service_name: str | None) -> bool:
    if not service_name or not command_available("systemctl"):
        return False

    result = subprocess.run(
        ["systemctl", "is-active", service_name],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0 and result.stdout.strip() == "active"


def normalize_domain(raw_domain: str) -> str:
    normalized = raw_domain.strip().lower().rstrip(".")
    if not normalized or not DOMAIN_PATTERN.fullmatch(normalized):
        raise HTTPException(status_code=400, detail="invalid domain")
    return normalized


def site_slug(domain: str) -> str:
    return domain.replace(".", "-")


def nginx_site_paths(domain: str) -> tuple[Path, Path]:
    file_name = f"files-agent-{site_slug(domain)}.conf"
    return (
        SETTINGS.nginx_sites_available_dir / file_name,
        SETTINGS.nginx_sites_enabled_dir / file_name,
    )


def render_nginx_site(domain: str, upstream_port: int) -> str:
    return (
        "server {\n"
        "    listen 80;\n"
        "    listen [::]:80;\n"
        f"    server_name {domain};\n\n"
        "    client_max_body_size 2g;\n\n"
        "    location / {\n"
        f"        proxy_pass http://127.0.0.1:{upstream_port};\n"
        "        proxy_http_version 1.1;\n"
        "        proxy_set_header Host $host;\n"
        "        proxy_set_header X-Real-IP $remote_addr;\n"
        "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
        "        proxy_set_header X-Forwarded-Proto $scheme;\n"
        "        proxy_set_header Upgrade $http_upgrade;\n"
        '        proxy_set_header Connection "upgrade";\n'
        "    }\n"
        "}\n"
    )


def certbot_args(domain: str, email: str | None) -> list[str]:
    command = [
        "certbot",
        "--nginx",
        "-d",
        domain,
        "--non-interactive",
        "--agree-tos",
        "--redirect",
        "--keep-until-expiring",
    ]
    if email:
        command.extend(["-m", email])
    else:
        command.append("--register-unsafely-without-email")
    return command


def tls_ready_for(domain: str | None, state: dict[str, object]) -> bool:
    if not domain:
        return False

    letsencrypt_cert = Path("/etc/letsencrypt/live") / domain / "fullchain.pem"
    if letsencrypt_cert.exists():
        return True
    return bool(state.get("https_enabled"))


def remove_nginx_site(domain: str) -> None:
    site_path, enabled_path = nginx_site_paths(domain)
    enabled_path.unlink(missing_ok=True)
    site_path.unlink(missing_ok=True)


def schedule_service_restart(service_name: str | None, *, allow_restart: bool | None = None) -> bool:
    if allow_restart is None:
        allow_restart = SETTINGS.allow_self_restart
    if not allow_restart or not service_name or not command_available("systemctl"):
        return False

    subprocess.Popen(
        [
            "/bin/sh",
            "-c",
            f"sleep 2 && systemctl restart {shlex.quote(service_name)} >/dev/null 2>&1",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return True


def build_access_status() -> AccessStatus:
    env_values = {**default_env_values(), **read_env_file(SETTINGS.env_file_path)}
    state = load_access_state()

    desired_host = env_values.get("HOST", SETTINGS.host)
    desired_port = int(env_values.get("PORT", SETTINGS.port))
    domain = state.get("domain") or env_values.get("PUBLIC_DOMAIN") or None
    https_enabled = tls_ready_for(domain, state)
    if domain:
        public_url = f"https://{domain}" if https_enabled else f"http://{domain}"
    else:
        public_url = None

    return AccessStatus(
        current_bind_host=SETTINGS.host,
        current_bind_port=SETTINGS.port,
        desired_bind_host=desired_host,
        desired_bind_port=desired_port,
        public_ip_access_enabled=is_public_bind(desired_host),
        domain=domain,
        public_url=public_url,
        nginx_available=command_available("nginx"),
        nginx_running=service_is_active(env_values.get("NGINX_SERVICE_NAME") or SETTINGS.nginx_service_name),
        certbot_available=command_available("certbot"),
        https_enabled=https_enabled,
        token_configured=bool(env_values.get("AGENT_TOKEN")),
        restart_pending=runtime_restart_needed(env_values),
    )


def build_config_response() -> ConfigResponse:
    env_values = {**default_env_values(), **read_env_file(SETTINGS.env_file_path)}
    desired_host = env_values.get("HOST", SETTINGS.host)
    desired_port = int(env_values.get("PORT", SETTINGS.port))
    public_domain = env_values.get("PUBLIC_DOMAIN") or load_access_state().get("domain") or None
    return ConfigResponse(
        agent_name=env_values.get("AGENT_NAME", SETTINGS.agent_name),
        agent_root=env_values.get("AGENT_ROOT", str(SETTINGS.root_path)),
        port=desired_port,
        allow_public_ip=is_public_bind(desired_host),
        certbot_email=env_values.get("CERTBOT_EMAIL") or None,
        allow_self_restart=env_flag(
            env_values.get("ALLOW_SELF_RESTART"),
            default=SETTINGS.allow_self_restart,
        ),
        public_domain=str(public_domain) if public_domain else None,
        token_configured=bool(env_values.get("AGENT_TOKEN")),
        auth_enabled=bool(SETTINGS.auth_token),
        current_bind_host=SETTINGS.host,
        current_bind_port=SETTINGS.port,
        desired_bind_host=desired_host,
        desired_bind_port=desired_port,
        restart_pending=runtime_restart_needed(env_values),
    )


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


def build_resources() -> ResourceSnapshot:
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage(SETTINGS.root_path)
    try:
        load_one, load_five, load_fifteen = os.getloadavg()
    except OSError:
        load_one = load_five = load_fifteen = 0.0
    cpu_count = os.cpu_count() or 1
    load_ratio_percent = min((load_one / cpu_count) * 100, 100.0)

    return ResourceSnapshot(
        hostname=socket.gethostname(),
        uptime=format_uptime(time.time() - psutil.boot_time()),
        cpu_count=cpu_count,
        load_ratio_percent=round(load_ratio_percent, 1),
        load_average=LoadAverage(one=load_one, five=load_five, fifteen=load_fifteen),
        memory=MemoryStats(
            total_mb=int(memory.total / 1024 / 1024),
            used_mb=int(memory.used / 1024 / 1024),
            free_mb=int(memory.free / 1024 / 1024),
            available_mb=int(memory.available / 1024 / 1024),
            used_percent=round(memory.percent, 1),
        ),
        root_disk=DiskStats(
            total=human_bytes(disk.total),
            used=human_bytes(disk.used),
            available=human_bytes(disk.free),
            used_percent=round(disk.percent, 1),
            mount_point=str(SETTINGS.root_path),
        ),
    )


app = FastAPI(title="Files Agent", version="1.0.0")


def build_history_point(snapshot: ResourceSnapshot | None = None) -> ResourceHistoryPoint:
    current = snapshot or build_resources()
    return ResourceHistoryPoint(
        timestamp=utc_now(),
        memory_used_percent=current.memory.used_percent,
        disk_used_percent=current.root_disk.used_percent,
        load_ratio_percent=current.load_ratio_percent,
    )


def resource_history_store() -> deque[ResourceHistoryPoint]:
    history = getattr(app.state, "resource_history", None)
    if history is None:
        history = deque(maxlen=RESOURCE_HISTORY_MAX_POINTS)
        history.append(build_history_point())
        app.state.resource_history = history
        app.state.resource_history_last_epoch = time.time()
    return history


def record_resource_history(
    snapshot: ResourceSnapshot | None = None,
    *,
    min_interval_seconds: int = 0,
) -> None:
    last_epoch = getattr(app.state, "resource_history_last_epoch", 0.0)
    now = time.time()
    if min_interval_seconds and now - last_epoch < min_interval_seconds:
        return
    resource_history_store().append(build_history_point(snapshot))
    app.state.resource_history_last_epoch = now


async def resource_sampler() -> None:
    while True:
        with suppress(Exception):
            record_resource_history()
        await asyncio.sleep(RESOURCE_SAMPLE_INTERVAL)


@app.on_event("startup")
async def on_startup() -> None:
    resource_history_store()
    app.state.resource_sampler_task = asyncio.create_task(resource_sampler())


@app.on_event("shutdown")
async def on_shutdown() -> None:
    task = getattr(app.state, "resource_sampler_task", None)
    if task is None:
        return
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


@app.get("/api/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", timestamp=utc_now(), auth_enabled=bool(SETTINGS.auth_token))


@app.get("/api/agent", response_model=AgentInfo)
async def agent_info() -> AgentInfo:
    return AgentInfo(
        agent_name=SETTINGS.agent_name,
        hostname=socket.gethostname(),
        current_user=pwd.getpwuid(os.getuid()).pw_name,
        root_path=str(SETTINGS.root_path),
        auth_enabled=bool(SETTINGS.auth_token),
    )


@app.get("/api/access", response_model=AccessStatus, dependencies=[Depends(require_auth)])
async def get_access_status() -> AccessStatus:
    return build_access_status()


@app.get("/api/config", response_model=ConfigResponse, dependencies=[Depends(require_auth)])
async def get_config() -> ConfigResponse:
    return build_config_response()


@app.post("/api/config", response_model=ConfigUpdateResponse, dependencies=[Depends(require_auth)])
async def update_config(request: ConfigUpdateRequest) -> ConfigUpdateResponse:
    env_values = {**default_env_values(), **read_env_file(SETTINGS.env_file_path)}
    agent_name = request.agent_name.strip()
    if not agent_name:
        raise HTTPException(status_code=400, detail="agent name is required")

    agent_root = normalize_existing_directory(request.agent_root)
    certbot_email = (request.certbot_email or "").strip()
    allow_public_ip = bool(request.allow_public_ip)
    allow_self_restart = bool(request.allow_self_restart)

    env_values["AGENT_NAME"] = agent_name
    env_values["AGENT_ROOT"] = str(agent_root)
    env_values["PORT"] = str(request.port)
    env_values["HOST"] = "0.0.0.0" if allow_public_ip else "127.0.0.1"
    env_values["CERTBOT_EMAIL"] = certbot_email
    env_values["ALLOW_SELF_RESTART"] = "1" if allow_self_restart else "0"

    try:
        write_env_file(SETTINGS.env_file_path, env_values)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to persist config: {exc}") from exc

    restart_required = runtime_restart_needed(env_values)
    restart_scheduled = False
    if restart_required:
        restart_scheduled = schedule_service_restart(
            env_values.get("AGENT_SERVICE_NAME") or SETTINGS.agent_service_name,
            allow_restart=allow_self_restart,
        )

    message = "configuration saved"
    if restart_required and restart_scheduled:
        message = "configuration saved; agent restart has been scheduled"
    elif restart_required:
        message = "configuration saved; restart required to apply changes"

    return ConfigUpdateResponse(
        message=message,
        restart_required=restart_required,
        restart_scheduled=restart_scheduled,
        config=build_config_response(),
    )


@app.post("/api/access/domain", response_model=DomainSetupResponse, dependencies=[Depends(require_auth)])
async def configure_domain_access(request: DomainSetupRequest) -> DomainSetupResponse:
    domain = normalize_domain(request.domain)
    if not command_available("nginx"):
        raise HTTPException(status_code=400, detail="nginx is not installed")
    if not command_available("certbot"):
        raise HTTPException(status_code=400, detail="certbot is not installed")
    if not command_available("systemctl"):
        raise HTTPException(status_code=400, detail="systemctl is not available")

    env_values = {**default_env_values(), **read_env_file(SETTINGS.env_file_path)}
    previous_state = load_access_state()
    previous_domain = previous_state.get("domain")
    site_path, enabled_path = nginx_site_paths(domain)
    previous_site_content = site_path.read_text(encoding="utf-8") if site_path.exists() else None

    try:
        SETTINGS.state_dir.mkdir(parents=True, exist_ok=True)
        SETTINGS.nginx_sites_available_dir.mkdir(parents=True, exist_ok=True)
        SETTINGS.nginx_sites_enabled_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to prepare config paths: {exc}") from exc

    try:
        site_path.write_text(render_nginx_site(domain, SETTINGS.port), encoding="utf-8")
        if not enabled_path.exists() and not enabled_path.is_symlink():
            enabled_path.symlink_to(site_path)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to write nginx config: {exc}") from exc

    try:
        run_command(["nginx", "-t"], "validate nginx config")
        run_command(
            ["systemctl", "enable", "--now", env_values.get("NGINX_SERVICE_NAME") or SETTINGS.nginx_service_name or "nginx"],
            "enable nginx",
        )
        run_command(
            ["systemctl", "reload", env_values.get("NGINX_SERVICE_NAME") or SETTINGS.nginx_service_name or "nginx"],
            "reload nginx",
        )
        run_command(
            certbot_args(domain, env_values.get("CERTBOT_EMAIL") or SETTINGS.certbot_email),
            "issue tls certificate",
        )
    except HTTPException:
        if previous_site_content is None:
            remove_nginx_site(domain)
        else:
            site_path.write_text(previous_site_content, encoding="utf-8")
            if not enabled_path.exists() and not enabled_path.is_symlink():
                enabled_path.symlink_to(site_path)
        try:
            run_command(["nginx", "-t"], "validate nginx rollback")
            run_command(
                ["systemctl", "reload", env_values.get("NGINX_SERVICE_NAME") or SETTINGS.nginx_service_name or "nginx"],
                "reload nginx rollback",
            )
        except HTTPException:
            pass
        raise

    if previous_domain and previous_domain != domain:
        remove_nginx_site(str(previous_domain))
        try:
            run_command(["nginx", "-t"], "validate nginx cleanup")
            run_command(
                ["systemctl", "reload", env_values.get("NGINX_SERVICE_NAME") or SETTINGS.nginx_service_name or "nginx"],
                "reload nginx cleanup",
            )
        except HTTPException:
            pass

    env_values["HOST"] = "127.0.0.1"
    env_values["PORT"] = str(SETTINGS.port)
    env_values["PUBLIC_DOMAIN"] = domain
    try:
        write_env_file(SETTINGS.env_file_path, env_values)
        save_access_state(
            {
                "domain": domain,
                "public_url": f"https://{domain}",
                "https_enabled": True,
                "configured_at": utc_now(),
            }
        )
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to persist access config: {exc}") from exc

    restart_scheduled = False
    if env_values.get("HOST") != SETTINGS.host or int(env_values.get("PORT", SETTINGS.port)) != SETTINGS.port:
        restart_scheduled = schedule_service_restart(
            env_values.get("AGENT_SERVICE_NAME") or SETTINGS.agent_service_name,
            allow_restart=env_flag(
                env_values.get("ALLOW_SELF_RESTART"),
                default=SETTINGS.allow_self_restart,
            ),
        )

    return DomainSetupResponse(
        message="domain configured through nginx; agent will switch to local-only access after restart",
        public_url=f"https://{domain}",
        desired_bind_host=env_values["HOST"],
        https_enabled=True,
        restart_scheduled=restart_scheduled,
    )


@app.get("/api/resources", response_model=ResourceSnapshot, dependencies=[Depends(require_auth)])
async def get_resources() -> ResourceSnapshot:
    snapshot = build_resources()
    record_resource_history(snapshot, min_interval_seconds=5)
    return snapshot


@app.get("/api/resources/history", response_model=ResourceHistoryResponse, dependencies=[Depends(require_auth)])
async def get_resource_history() -> ResourceHistoryResponse:
    return ResourceHistoryResponse(
        interval_seconds=RESOURCE_SAMPLE_INTERVAL,
        points=list(resource_history_store()),
    )


@app.get("/api/files", response_model=FileListResponse, dependencies=[Depends(require_auth)])
async def list_files(
    path: str | None = Query(default=None),
    show_hidden: bool = Query(default=False),
) -> FileListResponse:
    current_path = resolve_path(path)
    if not current_path.exists():
        raise HTTPException(status_code=404, detail="path not found")
    if not current_path.is_dir():
        raise HTTPException(status_code=400, detail="path is not a directory")

    try:
        parent_candidate = current_path.parent.resolve(strict=False)
        parent_candidate.relative_to(SETTINGS.root_path)
        parent_path = None if current_path == SETTINGS.root_path else str(parent_candidate)
    except ValueError:
        parent_path = None

    return FileListResponse(
        current_path=str(current_path),
        root_path=str(SETTINGS.root_path),
        parent_path=parent_path,
        show_hidden=show_hidden,
        entries=list_directory_entries(current_path, show_hidden=show_hidden),
    )


@app.post("/api/files/mkdir", response_model=MessageResponse, dependencies=[Depends(require_auth)])
async def create_directory(request: CreateDirectoryRequest) -> MessageResponse:
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
    return MessageResponse(message="directory created")


@app.delete("/api/files", response_model=MessageResponse, dependencies=[Depends(require_auth)])
async def delete_path(path: str = Query(...)) -> MessageResponse:
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

    return MessageResponse(message="deleted")


@app.post("/api/files/rename", response_model=MessageResponse, dependencies=[Depends(require_auth)])
async def rename_path(request: RenameFileRequest) -> MessageResponse:
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

    return MessageResponse(message="renamed")


@app.post("/api/files/upload", response_model=MessageResponse, dependencies=[Depends(require_auth)])
async def upload_file(
    file: UploadFile = File(...),
    path: str | None = Query(default=None),
) -> MessageResponse:
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

    return MessageResponse(message="uploaded")


@app.get("/api/files/download", dependencies=[Depends(require_auth)])
async def download_file(path: str = Query(...)) -> FileResponse:
    target = resolve_path(path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")

    media_type, _ = mimetypes.guess_type(target.name)
    return FileResponse(
        path=target,
        media_type=media_type or "application/octet-stream",
        filename=target.name,
    )


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


def run() -> None:
    uvicorn.run(
        "app.main:app",
        host=SETTINGS.host,
        port=SETTINGS.port,
        proxy_headers=True,
        forwarded_allow_ips="*",
    )
