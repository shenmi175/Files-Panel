from __future__ import annotations

import asyncio
import os
import socket
import time
from collections import deque
from contextlib import suppress

import psutil

from app.core.settings import (
    RESOURCE_HISTORY_MAX_POINTS,
    RESOURCE_SNAPSHOT_CACHE_TTL,
    SETTINGS,
)
from app.models import (
    DiskDeviceStats,
    DiskIOStats,
    DiskStats,
    InodeStats,
    LoadAverage,
    MemoryStats,
    NetworkInterfaceStats,
    NetworkStats,
    ProcessStats,
    ResourceHistoryPoint,
    ResourceHistoryResponse,
    ResourceRateTracker,
    ResourceSnapshot,
    SwapStats,
)
from app.services.common import format_uptime, human_bytes, utc_now


_resource_rate_tracker: ResourceRateTracker | None = None
_latest_resource_snapshot: ResourceSnapshot | None = None
_latest_resource_snapshot_epoch = 0.0
_resource_history: deque[ResourceHistoryPoint] = deque(maxlen=RESOURCE_HISTORY_MAX_POINTS)
_resource_history_last_epoch = 0.0
_resource_sampler_task: asyncio.Task[None] | None = None


def sample_inode_stats(target: os.PathLike[str] | str) -> InodeStats:
    stats = os.statvfs(target)
    total = stats.f_files
    free = stats.f_ffree
    used = max(total - free, 0)
    used_percent = 0.0 if total <= 0 else round((used / total) * 100, 1)
    return InodeStats(
        total=total,
        used=used,
        free=free,
        used_percent=used_percent,
        mount_point=str(target),
    )


def sample_process_stats() -> ProcessStats:
    total_processes = len(psutil.pids())
    tcp_connections = 0
    established_connections = 0
    with suppress(psutil.Error, PermissionError, OSError):
        connections = psutil.net_connections(kind="tcp")
        tcp_connections = len(connections)
        established_connections = sum(1 for item in connections if item.status == psutil.CONN_ESTABLISHED)
    return ProcessStats(
        total_processes=total_processes,
        tcp_connections=tcp_connections,
        established_connections=established_connections,
    )


def sample_resource_rates() -> tuple[
    NetworkStats,
    list[NetworkInterfaceStats],
    DiskIOStats,
    list[DiskDeviceStats],
]:
    global _resource_rate_tracker

    net = psutil.net_io_counters()
    net_per_nic = psutil.net_io_counters(pernic=True)
    disk_io = psutil.disk_io_counters()
    disk_io_per_device = psutil.disk_io_counters(perdisk=True)
    now = time.time()

    if _resource_rate_tracker is None:
        _resource_rate_tracker = ResourceRateTracker(
            timestamp=now,
            net_bytes_recv=net.bytes_recv if net else 0,
            net_bytes_sent=net.bytes_sent if net else 0,
            disk_read_bytes=disk_io.read_bytes if disk_io else 0,
            disk_write_bytes=disk_io.write_bytes if disk_io else 0,
            net_by_nic={
                name: (stats.bytes_recv, stats.bytes_sent)
                for name, stats in (net_per_nic or {}).items()
            },
            disk_by_device={
                name: (stats.read_bytes, stats.write_bytes)
                for name, stats in (disk_io_per_device or {}).items()
            },
        )
        return (
            NetworkStats(download_bps=0, upload_bps=0),
            [
                NetworkInterfaceStats(name=name, download_bps=0, upload_bps=0)
                for name in sorted((net_per_nic or {}).keys())
            ],
            DiskIOStats(read_bps=0, write_bps=0),
            [
                DiskDeviceStats(name=name, read_bps=0, write_bps=0)
                for name in sorted((disk_io_per_device or {}).keys())
            ],
        )

    elapsed = max(now - _resource_rate_tracker.timestamp, 0.001)
    download_bps = 0
    upload_bps = 0
    read_bps = 0
    write_bps = 0
    interface_stats: list[NetworkInterfaceStats] = []
    disk_device_stats: list[DiskDeviceStats] = []

    if net:
        download_bps = int(max(net.bytes_recv - _resource_rate_tracker.net_bytes_recv, 0) / elapsed)
        upload_bps = int(max(net.bytes_sent - _resource_rate_tracker.net_bytes_sent, 0) / elapsed)
        _resource_rate_tracker.net_bytes_recv = net.bytes_recv
        _resource_rate_tracker.net_bytes_sent = net.bytes_sent

    for name, stats in sorted((net_per_nic or {}).items()):
        previous_recv, previous_sent = _resource_rate_tracker.net_by_nic.get(
            name,
            (stats.bytes_recv, stats.bytes_sent),
        )
        interface_stats.append(
            NetworkInterfaceStats(
                name=name,
                download_bps=int(max(stats.bytes_recv - previous_recv, 0) / elapsed),
                upload_bps=int(max(stats.bytes_sent - previous_sent, 0) / elapsed),
            )
        )
        _resource_rate_tracker.net_by_nic[name] = (stats.bytes_recv, stats.bytes_sent)
    _resource_rate_tracker.net_by_nic = {
        name: _resource_rate_tracker.net_by_nic[name]
        for name in (net_per_nic or {}).keys()
    }

    if disk_io:
        read_bps = int(max(disk_io.read_bytes - _resource_rate_tracker.disk_read_bytes, 0) / elapsed)
        write_bps = int(max(disk_io.write_bytes - _resource_rate_tracker.disk_write_bytes, 0) / elapsed)
        _resource_rate_tracker.disk_read_bytes = disk_io.read_bytes
        _resource_rate_tracker.disk_write_bytes = disk_io.write_bytes

    for name, stats in sorted((disk_io_per_device or {}).items()):
        previous_read, previous_write = _resource_rate_tracker.disk_by_device.get(
            name,
            (stats.read_bytes, stats.write_bytes),
        )
        disk_device_stats.append(
            DiskDeviceStats(
                name=name,
                read_bps=int(max(stats.read_bytes - previous_read, 0) / elapsed),
                write_bps=int(max(stats.write_bytes - previous_write, 0) / elapsed),
            )
        )
        _resource_rate_tracker.disk_by_device[name] = (stats.read_bytes, stats.write_bytes)
    _resource_rate_tracker.disk_by_device = {
        name: _resource_rate_tracker.disk_by_device[name]
        for name in (disk_io_per_device or {}).keys()
    }

    _resource_rate_tracker.timestamp = now
    return (
        NetworkStats(download_bps=download_bps, upload_bps=upload_bps),
        interface_stats,
        DiskIOStats(read_bps=read_bps, write_bps=write_bps),
        disk_device_stats,
    )


def collect_resource_snapshot() -> ResourceSnapshot:
    global _latest_resource_snapshot, _latest_resource_snapshot_epoch

    memory = psutil.virtual_memory()
    swap = psutil.swap_memory()
    disk = psutil.disk_usage(SETTINGS.root_path)
    try:
        load_one, load_five, load_fifteen = os.getloadavg()
    except OSError:
        load_one = load_five = load_fifteen = 0.0

    cpu_count = os.cpu_count() or 1
    cpu_used_percent = psutil.cpu_percent(interval=None)
    load_ratio_percent = min((load_one / cpu_count) * 100, 100.0)
    network_stats, network_interfaces, disk_io_stats, disk_devices = sample_resource_rates()
    inode_stats = sample_inode_stats(SETTINGS.root_path)
    process_stats = sample_process_stats()

    snapshot = ResourceSnapshot(
        sampled_at=utc_now(),
        hostname=socket.gethostname(),
        uptime=format_uptime(time.time() - psutil.boot_time()),
        cpu_count=cpu_count,
        cpu_used_percent=round(cpu_used_percent, 1),
        load_ratio_percent=round(load_ratio_percent, 1),
        load_average=LoadAverage(one=load_one, five=load_five, fifteen=load_fifteen),
        memory=MemoryStats(
            total_mb=int(memory.total / 1024 / 1024),
            used_mb=int(memory.used / 1024 / 1024),
            free_mb=int(memory.free / 1024 / 1024),
            available_mb=int(memory.available / 1024 / 1024),
            used_percent=round(memory.percent, 1),
        ),
        swap=SwapStats(
            total_mb=int(swap.total / 1024 / 1024),
            used_mb=int(swap.used / 1024 / 1024),
            free_mb=int(swap.free / 1024 / 1024),
            used_percent=round(swap.percent, 1),
        ),
        root_disk=DiskStats(
            total=human_bytes(disk.total),
            used=human_bytes(disk.used),
            available=human_bytes(disk.free),
            used_percent=round(disk.percent, 1),
            mount_point=str(SETTINGS.root_path),
        ),
        inode=inode_stats,
        processes=process_stats,
        network=network_stats,
        network_interfaces=network_interfaces,
        disk_io=disk_io_stats,
        disk_devices=disk_devices,
    )
    _latest_resource_snapshot = snapshot
    _latest_resource_snapshot_epoch = time.time()
    return snapshot


def get_resource_snapshot(*, force_refresh: bool = False) -> ResourceSnapshot:
    if (
        not force_refresh
        and _latest_resource_snapshot is not None
        and time.time() - _latest_resource_snapshot_epoch < RESOURCE_SNAPSHOT_CACHE_TTL
    ):
        return _latest_resource_snapshot
    return collect_resource_snapshot()


def build_history_point(snapshot: ResourceSnapshot | None = None) -> ResourceHistoryPoint:
    current = snapshot or get_resource_snapshot()
    return ResourceHistoryPoint(
        timestamp=utc_now(),
        cpu_used_percent=current.cpu_used_percent,
        memory_used_percent=current.memory.used_percent,
        disk_used_percent=current.root_disk.used_percent,
        load_ratio_percent=current.load_ratio_percent,
    )


def resource_history_store() -> deque[ResourceHistoryPoint]:
    global _resource_history_last_epoch

    if not _resource_history:
        _resource_history.append(build_history_point(collect_resource_snapshot()))
        _resource_history_last_epoch = time.time()
    return _resource_history


def record_resource_history(
    snapshot: ResourceSnapshot | None = None,
    *,
    min_interval_seconds: int = 0,
) -> None:
    global _resource_history_last_epoch

    now = time.time()
    if min_interval_seconds and now - _resource_history_last_epoch < min_interval_seconds:
        return
    resource_history_store().append(build_history_point(snapshot))
    _resource_history_last_epoch = now


async def resource_sampler() -> None:
    while True:
        with suppress(Exception):
            record_resource_history(collect_resource_snapshot())
        await asyncio.sleep(SETTINGS.sample_interval_seconds)


async def on_startup() -> None:
    global _resource_sampler_task, _resource_history_last_epoch, _resource_history

    psutil.cpu_percent(interval=None)
    initial_snapshot = collect_resource_snapshot()
    _resource_history = deque([build_history_point(initial_snapshot)], maxlen=RESOURCE_HISTORY_MAX_POINTS)
    _resource_history_last_epoch = time.time()
    _resource_sampler_task = asyncio.create_task(resource_sampler())


async def on_shutdown() -> None:
    global _resource_sampler_task

    if _resource_sampler_task is None:
        return
    _resource_sampler_task.cancel()
    with suppress(asyncio.CancelledError):
        await _resource_sampler_task
    _resource_sampler_task = None


def get_resource_history() -> ResourceHistoryResponse:
    return ResourceHistoryResponse(
        interval_seconds=SETTINGS.sample_interval_seconds,
        points=list(resource_history_store()),
    )
