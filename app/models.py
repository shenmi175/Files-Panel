from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, Field


UpdateChannel = Literal["stable", "rc", "main"]


class HealthResponse(BaseModel):
    status: str
    timestamp: str
    auth_enabled: bool
    registration_required: bool


class LoginRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=8, max_length=512)


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=8, max_length=512)


class LoginResponse(BaseModel):
    message: str
    authenticated: bool
    username: str | None = None


class SessionStatusResponse(BaseModel):
    auth_enabled: bool
    authenticated: bool
    registration_required: bool
    username: str | None = None


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
    network_download_bps: int = 0
    network_upload_bps: int = 0


class ResourceMetricRollup(BaseModel):
    current: float | None = None
    average_1m: float | None = None
    average_5m: float | None = None


class ResourceHistorySummary(BaseModel):
    cpu_used_percent: ResourceMetricRollup
    memory_used_percent: ResourceMetricRollup
    disk_used_percent: ResourceMetricRollup
    load_ratio_percent: ResourceMetricRollup
    network_download_bps: ResourceMetricRollup = Field(default_factory=ResourceMetricRollup)
    network_upload_bps: ResourceMetricRollup = Field(default_factory=ResourceMetricRollup)
    network_download_bytes: int = 0
    network_upload_bytes: int = 0


class ResourceHistoryResponse(BaseModel):
    interval_seconds: int
    resolution_seconds: int
    range_key: str
    range_seconds: int
    sampled_from: str | None
    sampled_to: str | None
    point_count: int
    points: list[ResourceHistoryPoint]
    summary: ResourceHistorySummary


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
    browse_mode: str = "workspace"
    read_only: bool = False
    system_roots: list[str] = Field(default_factory=list)
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
    update_channel: UpdateChannel
    available_update_channels: list[UpdateChannel] = Field(default_factory=list)
    system_readonly_paths: list[str] = Field(default_factory=list)


class ConfigUpdateRequest(BaseModel):
    agent_name: str = Field(min_length=1, max_length=120)
    agent_root: str = Field(min_length=1, max_length=2048)
    port: int = Field(ge=1, le=65535)
    resource_sample_interval: int = Field(ge=5, le=15)
    agent_token: str | None = Field(default=None, max_length=512)
    allow_public_ip: bool
    certbot_email: str | None = Field(default=None, max_length=254)
    allow_self_restart: bool
    update_channel: UpdateChannel = "main"


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
    browse_mode: str | None = None


class CreateDirectoryRequest(BaseModel):
    path: str
    browse_mode: str | None = None


class MessageResponse(BaseModel):
    message: str


class UpdateStatusResponse(BaseModel):
    role: str
    source_dir: str | None
    source_dir_exists: bool
    project_dir_valid: bool
    git_available: bool
    git_repo: bool
    auto_update_available: bool
    channel: UpdateChannel
    available_channels: list[UpdateChannel] = Field(default_factory=list)
    channel_ref: str
    channel_exists: bool = False
    current_version: str | None = None
    latest_version: str | None = None
    update_available: bool = False
    latest_checked_at: str | None = None
    status: str
    mode: str | None = None
    pull_latest: bool | None = None
    started_at: str | None = None
    finished_at: str | None = None
    message: str | None = None
    log_path: str | None = None


class UpdateTriggerRequest(BaseModel):
    mode: Literal["quick", "redeploy", "full-install"] = "quick"
    pull_latest: bool = True
    channel: UpdateChannel | None = None


class UpdateTriggerResponse(BaseModel):
    message: str
    scheduled: bool
    status: UpdateStatusResponse


class BatchUpdateNodeResult(BaseModel):
    server_id: int
    server_name: str
    scheduled: bool
    message: str


class BatchUpdateTriggerResponse(BaseModel):
    message: str
    mode: Literal["quick", "redeploy", "full-install"]
    pull_latest: bool
    total_nodes: int
    scheduled_nodes: int
    failed_nodes: int
    results: list[BatchUpdateNodeResult]


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


class WireGuardBootstrapStatusResponse(BaseModel):
    available: bool
    interface_name: str
    manager_address: str | None = None
    manager_network: str | None = None
    public_key: str | None = None
    listen_port: int | None = None
    message: str | None = None


class WireGuardBootstrapPrepareRequest(BaseModel):
    manager_url: str = Field(min_length=1, max_length=512)
    endpoint_host: str | None = Field(default=None, max_length=255)
    node_name: str | None = Field(default=None, max_length=120)
    expires_in_minutes: int = Field(default=20, ge=5, le=120)


class WireGuardBootstrapPrepareResponse(BaseModel):
    message: str
    manager_url: str
    endpoint_host: str
    bootstrap_token: str
    expires_at: str
    install_command: str
    bootstrap_command: str
    combined_command: str


class WireGuardBootstrapRegisterRequest(BaseModel):
    agent_name: str = Field(min_length=1, max_length=120)
    agent_token: str = Field(min_length=16, max_length=512)
    public_key: str = Field(min_length=20, max_length=120)
    agent_port: int = Field(default=3000, ge=1, le=65535)


class WireGuardBootstrapRegisterResponse(BaseModel):
    message: str
    server_id: int
    server_name: str
    manager_url: str
    wireguard_ip: str
    address_cidr: str
    network_cidr: str
    endpoint: str
    manager_public_key: str
    allowed_ips: str
    persistent_keepalive: int
    base_url: str


@dataclass
class ResourceRateTracker:
    timestamp: float
    net_bytes_recv: int
    net_bytes_sent: int
    disk_read_bytes: int
    disk_write_bytes: int
    net_by_nic: dict[str, tuple[int, int]]
    disk_by_device: dict[str, tuple[int, int]]
