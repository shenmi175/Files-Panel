from __future__ import annotations

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
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import psutil
import uvicorn
from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel


BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
ACCESS_STATE_FILE = "access.json"
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
    caddyfile_path: Path
    agent_service_name: str | None
    caddy_service_name: str | None
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
        caddyfile_path=Path(os.getenv("CADDYFILE_PATH", "/etc/caddy/Caddyfile")).expanduser(),
        agent_service_name=os.getenv("AGENT_SERVICE_NAME", "files-agent").strip() or None,
        caddy_service_name=os.getenv("CADDY_SERVICE_NAME", "caddy").strip() or None,
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
    caddy_available: bool
    caddy_running: bool
    token_configured: bool
    restart_pending: bool


class DomainSetupRequest(BaseModel):
    domain: str


class DomainSetupResponse(BaseModel):
    message: str
    public_url: str
    desired_bind_host: str
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


class DiskStats(BaseModel):
    total: str
    used: str
    available: str
    used_percent: str
    mount_point: str


class ResourceSnapshot(BaseModel):
    hostname: str
    uptime: str
    load_average: LoadAverage
    memory: MemoryStats
    root_disk: DiskStats


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
    entries: list[FileEntry]


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


def default_env_values() -> dict[str, str]:
    return {
        "HOST": SETTINGS.host,
        "PORT": str(SETTINGS.port),
        "AGENT_NAME": SETTINGS.agent_name,
        "AGENT_ROOT": str(SETTINGS.root_path),
        "AGENT_TOKEN": SETTINGS.auth_token or "",
        "ENV_FILE_PATH": str(SETTINGS.env_file_path),
        "STATE_DIR": str(SETTINGS.state_dir),
        "CADDYFILE_PATH": str(SETTINGS.caddyfile_path),
        "AGENT_SERVICE_NAME": SETTINGS.agent_service_name or "",
        "CADDY_SERVICE_NAME": SETTINGS.caddy_service_name or "",
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
        "CADDYFILE_PATH",
        "AGENT_SERVICE_NAME",
        "CADDY_SERVICE_NAME",
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


def load_access_state() -> dict[str, str]:
    state_path = access_state_path()
    if not state_path.exists():
        return {}
    try:
        return json.loads(state_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_access_state(payload: dict[str, str]) -> None:
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


def render_caddyfile(domain: str, upstream_port: int) -> str:
    return (
        f"{domain} {{\n"
        "    encode gzip zstd\n"
        f"    reverse_proxy 127.0.0.1:{upstream_port}\n"
        "}\n"
    )


def schedule_service_restart(service_name: str | None) -> bool:
    if not SETTINGS.allow_self_restart or not service_name or not command_available("systemctl"):
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
    public_url = f"https://{domain}" if domain else None

    return AccessStatus(
        current_bind_host=SETTINGS.host,
        current_bind_port=SETTINGS.port,
        desired_bind_host=desired_host,
        desired_bind_port=desired_port,
        public_ip_access_enabled=desired_host not in {"127.0.0.1", "::1", "localhost"},
        domain=domain,
        public_url=public_url,
        caddy_available=command_available("caddy"),
        caddy_running=service_is_active(env_values.get("CADDY_SERVICE_NAME") or SETTINGS.caddy_service_name),
        token_configured=bool(env_values.get("AGENT_TOKEN")),
        restart_pending=desired_host != SETTINGS.host or desired_port != SETTINGS.port,
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


def list_directory_entries(target: Path) -> list[FileEntry]:
    try:
        entries: list[FileEntry] = []
        with os.scandir(target) as iterator:
            for entry in iterator:
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

    return ResourceSnapshot(
        hostname=socket.gethostname(),
        uptime=format_uptime(time.time() - psutil.boot_time()),
        load_average=LoadAverage(one=load_one, five=load_five, fifteen=load_fifteen),
        memory=MemoryStats(
            total_mb=int(memory.total / 1024 / 1024),
            used_mb=int(memory.used / 1024 / 1024),
            free_mb=int(memory.free / 1024 / 1024),
            available_mb=int(memory.available / 1024 / 1024),
        ),
        root_disk=DiskStats(
            total=human_bytes(disk.total),
            used=human_bytes(disk.used),
            available=human_bytes(disk.free),
            used_percent=f"{disk.percent:.0f}%",
            mount_point=str(SETTINGS.root_path),
        ),
    )


app = FastAPI(title="Files Agent", version="1.0.0")


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


@app.post("/api/access/domain", response_model=DomainSetupResponse, dependencies=[Depends(require_auth)])
async def configure_domain_access(request: DomainSetupRequest) -> DomainSetupResponse:
    domain = normalize_domain(request.domain)
    if not command_available("caddy"):
        raise HTTPException(status_code=400, detail="caddy is not installed")
    if not command_available("systemctl"):
        raise HTTPException(status_code=400, detail="systemctl is not available")

    pending_caddyfile = SETTINGS.state_dir / "Caddyfile.pending"
    try:
        SETTINGS.state_dir.mkdir(parents=True, exist_ok=True)
        SETTINGS.caddyfile_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to prepare config paths: {exc}") from exc

    previous_caddyfile = None
    if SETTINGS.caddyfile_path.exists():
        previous_caddyfile = SETTINGS.caddyfile_path.read_text(encoding="utf-8")

    try:
        pending_caddyfile.write_text(render_caddyfile(domain, SETTINGS.port), encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to write caddy config: {exc}") from exc

    run_command(["caddy", "validate", "--config", str(pending_caddyfile)], "validate caddy config")

    try:
        shutil.copy2(pending_caddyfile, SETTINGS.caddyfile_path)
        if SETTINGS.caddy_service_name:
            run_command(["systemctl", "enable", "--now", SETTINGS.caddy_service_name], "enable caddy")
            run_command(["systemctl", "reload", SETTINGS.caddy_service_name], "reload caddy")
        else:
            run_command(["caddy", "reload", "--config", str(SETTINGS.caddyfile_path)], "reload caddy")
    except HTTPException:
        if previous_caddyfile is None:
            SETTINGS.caddyfile_path.unlink(missing_ok=True)
        else:
            SETTINGS.caddyfile_path.write_text(previous_caddyfile, encoding="utf-8")
        raise

    env_values = {**default_env_values(), **read_env_file(SETTINGS.env_file_path)}
    env_values["HOST"] = "127.0.0.1"
    env_values["PORT"] = str(SETTINGS.port)
    env_values["PUBLIC_DOMAIN"] = domain
    try:
        write_env_file(SETTINGS.env_file_path, env_values)
        save_access_state(
            {
                "domain": domain,
                "public_url": f"https://{domain}",
                "configured_at": utc_now(),
            }
        )
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to persist access config: {exc}") from exc

    restart_scheduled = False
    if env_values.get("HOST") != SETTINGS.host or int(env_values.get("PORT", SETTINGS.port)) != SETTINGS.port:
        restart_scheduled = schedule_service_restart(env_values.get("AGENT_SERVICE_NAME") or SETTINGS.agent_service_name)

    return DomainSetupResponse(
        message="domain configured; agent will switch to local-only access after restart",
        public_url=f"https://{domain}",
        desired_bind_host=env_values["HOST"],
        restart_scheduled=restart_scheduled,
    )


@app.get("/api/resources", response_model=ResourceSnapshot, dependencies=[Depends(require_auth)])
async def get_resources() -> ResourceSnapshot:
    return build_resources()


@app.get("/api/files", response_model=FileListResponse, dependencies=[Depends(require_auth)])
async def list_files(path: str | None = Query(default=None)) -> FileListResponse:
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
        entries=list_directory_entries(current_path),
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
