from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str
    timestamp: str
    auth_enabled: bool


class LoginRequest(BaseModel):
    token: str = Field(min_length=1, max_length=512)


class LoginResponse(BaseModel):
    message: str
    authenticated: bool


class SessionStatusResponse(BaseModel):
    auth_enabled: bool
    authenticated: bool


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


class SwapStats(BaseModel):
    total_mb: int
    used_mb: int
    free_mb: int
    used_percent: float


class InodeStats(BaseModel):
    total: int
    used: int
    free: int
    used_percent: float
    mount_point: str


class ProcessStats(BaseModel):
    total_processes: int
    tcp_connections: int
    established_connections: int


class NetworkStats(BaseModel):
    download_bps: int
    upload_bps: int


class NetworkInterfaceStats(BaseModel):
    name: str
    download_bps: int
    upload_bps: int


class DiskIOStats(BaseModel):
    read_bps: int
    write_bps: int


class DiskDeviceStats(BaseModel):
    name: str
    read_bps: int
    write_bps: int


class DiskStats(BaseModel):
    total: str
    used: str
    available: str
    used_percent: float
    mount_point: str


class ResourceSnapshot(BaseModel):
    sampled_at: str
    hostname: str
    uptime: str
    cpu_count: int
    cpu_used_percent: float
    load_ratio_percent: float
    load_average: LoadAverage
    memory: MemoryStats
    swap: SwapStats
    root_disk: DiskStats
    inode: InodeStats
    processes: ProcessStats
    network: NetworkStats
    network_interfaces: list[NetworkInterfaceStats]
    disk_io: DiskIOStats
    disk_devices: list[DiskDeviceStats]


class ResourceHistoryPoint(BaseModel):
    timestamp: str
    cpu_used_percent: float
    memory_used_percent: float
    disk_used_percent: float
    load_ratio_percent: float


class ResourceHistoryResponse(BaseModel):
    interval_seconds: int
    points: list[ResourceHistoryPoint]


class DockerContainerSummary(BaseModel):
    id: str
    name: str
    image: str
    state: str
    status: str
    ports: str
    running_for: str
    cpu_percent: str | None = None
    memory_usage: str | None = None
    memory_percent: str | None = None
    network_io: str | None = None
    block_io: str | None = None
    pids: str | None = None


class DockerStatusResponse(BaseModel):
    available: bool
    running_count: int
    message: str | None = None
    containers: list[DockerContainerSummary]


class LogEntry(BaseModel):
    cursor: str | None
    timestamp: str
    message: str
    level: str
    priority: str | None = None
    pid: int | None = None
    unit: str | None = None


class LogsResponse(BaseModel):
    available: bool
    service_name: str | None
    cursor: str | None
    level_filter: str
    message: str | None = None
    lines: list[LogEntry]


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


class DownloadLinkResponse(BaseModel):
    url: str
    expires_in_seconds: int


class ConfigResponse(BaseModel):
    agent_name: str
    agent_root: str
    port: int
    resource_sample_interval: int
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
    database_path: str


class ConfigUpdateRequest(BaseModel):
    agent_name: str = Field(min_length=1, max_length=120)
    agent_root: str = Field(min_length=1, max_length=2048)
    port: int = Field(ge=1, le=65535)
    resource_sample_interval: int = Field(ge=5, le=15)
    agent_token: str | None = Field(default=None, max_length=512)
    allow_public_ip: bool
    certbot_email: str | None = Field(default=None, max_length=254)
    allow_self_restart: bool


class ConfigUpdateResponse(BaseModel):
    message: str
    restart_required: bool
    restart_scheduled: bool
    config: ConfigResponse


class TokenResetResponse(BaseModel):
    message: str
    token: str
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


class ServerRecord(BaseModel):
    id: int
    name: str
    base_url: str | None
    wireguard_ip: str | None
    enabled: bool
    is_local: bool
    last_seen_at: str | None = None
    created_at: str
    updated_at: str


class ServerListResponse(BaseModel):
    items: list[ServerRecord]


class ServerUpsertRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    base_url: str | None = Field(default=None, max_length=512)
    auth_token: str | None = Field(default=None, max_length=512)
    wireguard_ip: str | None = Field(default=None, max_length=120)
    enabled: bool = True


class ServerMutationResponse(BaseModel):
    message: str
    server: ServerRecord


@dataclass
class ResourceRateTracker:
    timestamp: float
    net_bytes_recv: int
    net_bytes_sent: int
    disk_read_bytes: int
    disk_write_bytes: int
    net_by_nic: dict[str, tuple[int, int]]
    disk_by_device: dict[str, tuple[int, int]]
