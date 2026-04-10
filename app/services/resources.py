from __future__ import annotations

import asyncio
import math
import os
import socket
import time
from contextlib import suppress
from datetime import datetime, timedelta, timezone

import psutil

from app.core import storage
from app.core.settings import (
    RESOURCE_HISTORY_RETENTION_DAYS,
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
    ResourceHistorySummary,
    ResourceMetricRollup,
    ResourceRateTracker,
    ResourceSnapshot,
    SwapStats,
)
from app.services.common import format_uptime, human_bytes, utc_now


RESOURCE_HISTORY_RANGES: dict[str, int] = {
    "1d": 24 * 60 * 60,
    "7d": 7 * 24 * 60 * 60,
    "15d": 15 * 24 * 60 * 60,
    "30d": 30 * 24 * 60 * 60,
}
DEFAULT_RESOURCE_HISTORY_RANGE = "30d"
RESOURCE_HISTORY_RANGE_ALIASES: dict[str, str] = {
    "15m": "1d",
    "1h": "1d",
    "6h": "1d",
    "24h": "1d",
}
RESOURCE_HISTORY_MAX_CHART_POINTS = 240
RESOURCE_HISTORY_PRUNE_INTERVAL_SECONDS = 6 * 60 * 60

_resource_rate_tracker: ResourceRateTracker | None = None
_latest_resource_snapshot: ResourceSnapshot | None = None
_latest_resource_snapshot_epoch = 0.0
_resource_history_last_epoch = 0.0
_resource_prune_last_epoch = 0.0
_resource_sampler_task: asyncio.Task[None] | None = None


def _utc_datetime_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_utc_timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _round_metric(value: float | None) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(value, 1)


def _resolve_history_range(range_key: str | None) -> tuple[str, int]:
    normalized = str(range_key or DEFAULT_RESOURCE_HISTORY_RANGE).strip().lower()
    normalized = RESOURCE_HISTORY_RANGE_ALIASES.get(normalized, normalized)
    seconds = RESOURCE_HISTORY_RANGES.get(normalized)
    if seconds is None:
        return DEFAULT_RESOURCE_HISTORY_RANGE, RESOURCE_HISTORY_RANGES[DEFAULT_RESOURCE_HISTORY_RANGE]
    return normalized, seconds


def _record_to_history_point(record: dict[str, float | int | str]) -> ResourceHistoryPoint:
    return ResourceHistoryPoint(
        timestamp=str(record["sampled_at"]),
        cpu_used_percent=float(record["cpu_used_percent"]),
        memory_used_percent=float(record["memory_used_percent"]),
        disk_used_percent=float(record["disk_used_percent"]),
        load_ratio_percent=float(record["load_ratio_percent"]),
        network_download_bps=int(record.get("network_download_bps") or 0),
        network_upload_bps=int(record.get("network_upload_bps") or 0),
    )


def _serialize_snapshot(snapshot: ResourceSnapshot) -> dict[str, float | int | str]:
    return {
        "sampled_at": snapshot.sampled_at,
        "cpu_used_percent": snapshot.cpu_used_percent,
        "memory_used_percent": snapshot.memory.used_percent,
        "disk_used_percent": snapshot.root_disk.used_percent,
        "load_ratio_percent": snapshot.load_ratio_percent,
        "network_download_bps": snapshot.network.download_bps,
        "network_upload_bps": snapshot.network.upload_bps,
        "disk_read_bps": snapshot.disk_io.read_bps,
        "disk_write_bps": snapshot.disk_io.write_bps,
    }


def _rolling_average(
    records: list[dict[str, float | int | str]],
    key: str,
    *,
    latest_at: datetime,
    window_seconds: int,
) -> float | None:
    cutoff = latest_at - timedelta(seconds=window_seconds)
    values: list[float] = []
    for record in reversed(records):
        sampled_at = _parse_utc_timestamp(str(record["sampled_at"]))
        if sampled_at < cutoff:
            break
        values.append(float(record[key]))
    if not values:
        return None
    return sum(values) / len(values)


def _build_metric_rollup(
    records: list[dict[str, float | int | str]],
    key: str,
    *,
    latest_at: datetime,
) -> ResourceMetricRollup:
    current = float(records[-1][key]) if records else None
    return ResourceMetricRollup(
        current=_round_metric(current),
        average_1m=_round_metric(
            _rolling_average(records, key, latest_at=latest_at, window_seconds=60)
        ),
        average_5m=_round_metric(
            _rolling_average(records, key, latest_at=latest_at, window_seconds=5 * 60)
        ),
    )


def _build_history_summary(
    records: list[dict[str, float | int | str]],
    *,
    range_start: datetime,
    base_resolution_seconds: int,
) -> ResourceHistorySummary:
    if not records:
        empty = ResourceMetricRollup(current=None, average_1m=None, average_5m=None)
        return ResourceHistorySummary(
            cpu_used_percent=empty,
            memory_used_percent=empty,
            disk_used_percent=empty,
            load_ratio_percent=empty,
            network_download_bps=empty,
            network_upload_bps=empty,
            network_download_bytes=0,
            network_upload_bytes=0,
        )

    download_bytes = 0.0
    upload_bytes = 0.0
    previous_sampled_at: datetime | None = None
    for record in records:
        sampled_at = _parse_utc_timestamp(str(record["sampled_at"]))
        if previous_sampled_at is None:
            elapsed_seconds = max((sampled_at - range_start).total_seconds(), 0.0)
            if elapsed_seconds <= 0:
                elapsed_seconds = float(base_resolution_seconds)
        else:
            elapsed_seconds = max((sampled_at - previous_sampled_at).total_seconds(), 0.0)

        download_bytes += float(record.get("network_download_bps") or 0) * elapsed_seconds
        upload_bytes += float(record.get("network_upload_bps") or 0) * elapsed_seconds
        previous_sampled_at = sampled_at

    latest_at = _parse_utc_timestamp(str(records[-1]["sampled_at"]))
    return ResourceHistorySummary(
        cpu_used_percent=_build_metric_rollup(records, "cpu_used_percent", latest_at=latest_at),
        memory_used_percent=_build_metric_rollup(records, "memory_used_percent", latest_at=latest_at),
        disk_used_percent=_build_metric_rollup(records, "disk_used_percent", latest_at=latest_at),
        load_ratio_percent=_build_metric_rollup(records, "load_ratio_percent", latest_at=latest_at),
        network_download_bps=_build_metric_rollup(records, "network_download_bps", latest_at=latest_at),
        network_upload_bps=_build_metric_rollup(records, "network_upload_bps", latest_at=latest_at),
        network_download_bytes=int(round(download_bytes)),
        network_upload_bytes=int(round(upload_bytes)),
    )


def _downsample_history_points(
    records: list[dict[str, float | int | str]],
    *,
    range_start: datetime,
    base_resolution_seconds: int,
) -> tuple[list[ResourceHistoryPoint], int]:
    if len(records) <= RESOURCE_HISTORY_MAX_CHART_POINTS:
        return [_record_to_history_point(record) for record in records], base_resolution_seconds

    bucket_seconds = max(
        base_resolution_seconds,
        math.ceil(len(records) / RESOURCE_HISTORY_MAX_CHART_POINTS) * base_resolution_seconds,
    )
    buckets: dict[int, list[dict[str, float | int | str]]] = {}

    for record in records:
        sampled_at = _parse_utc_timestamp(str(record["sampled_at"]))
        bucket_index = max(
            0,
            int((sampled_at - range_start).total_seconds() // bucket_seconds),
        )
        buckets.setdefault(bucket_index, []).append(record)

    points: list[ResourceHistoryPoint] = []
    for bucket_index in sorted(buckets):
        bucket = buckets[bucket_index]
        last_record = bucket[-1]
        count = len(bucket)
        points.append(
            ResourceHistoryPoint(
                timestamp=str(last_record["sampled_at"]),
                cpu_used_percent=round(
                    sum(float(item["cpu_used_percent"]) for item in bucket) / count,
                    1,
                ),
                memory_used_percent=round(
                    sum(float(item["memory_used_percent"]) for item in bucket) / count,
                    1,
                ),
                disk_used_percent=round(
                    sum(float(item["disk_used_percent"]) for item in bucket) / count,
                    1,
                ),
                load_ratio_percent=round(
                    sum(float(item["load_ratio_percent"]) for item in bucket) / count,
                    1,
                ),
                network_download_bps=round(
                    sum(float(item["network_download_bps"]) for item in bucket) / count
                ),
                network_upload_bps=round(
                    sum(float(item["network_upload_bps"]) for item in bucket) / count
                ),
            )
        )
    return points, bucket_seconds


def _persist_resource_snapshot(snapshot: ResourceSnapshot) -> None:
    storage.save_resource_sample(_serialize_snapshot(snapshot))


def _prune_resource_history(now_epoch: float) -> None:
    global _resource_prune_last_epoch

    if now_epoch - _resource_prune_last_epoch < RESOURCE_HISTORY_PRUNE_INTERVAL_SECONDS:
        return
    cutoff = (_utc_datetime_now() - timedelta(days=RESOURCE_HISTORY_RETENTION_DAYS)).isoformat()
    storage.prune_resource_samples(cutoff)
    _resource_prune_last_epoch = now_epoch


def resolve_mount_point(target: os.PathLike[str] | str) -> str:
    current = os.path.realpath(os.fspath(target))
    while True:
        parent = os.path.dirname(current.rstrip(os.sep)) or os.sep
        try:
            current_device = os.stat(current).st_dev
            parent_device = os.stat(parent).st_dev
        except OSError:
            return current
        if current == parent or current_device != parent_device:
            return current
        current = parent


def sample_inode_stats(target: os.PathLike[str] | str) -> InodeStats:
    mount_point = resolve_mount_point(target)
    stats = os.statvfs(mount_point)
    total = stats.f_files
    free = stats.f_ffree
    used = max(total - free, 0)
    used_percent = 0.0 if total <= 0 else round((used / total) * 100, 1)
    return InodeStats(
        total=total,
        used=used,
        free=free,
        used_percent=used_percent,
        mount_point=mount_point,
    )


def sample_process_stats() -> ProcessStats:
    total_processes = len(psutil.pids())
    tcp_connections = 0
    established_connections = 0
    with suppress(psutil.Error, PermissionError, OSError):
        connections = psutil.net_connections(kind="tcp")
        tcp_connections = len(connections)
        established_connections = sum(
            1 for item in connections if item.status == psutil.CONN_ESTABLISHED
        )
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
        download_bps = int(
            max(net.bytes_recv - _resource_rate_tracker.net_bytes_recv, 0) / elapsed
        )
        upload_bps = int(
            max(net.bytes_sent - _resource_rate_tracker.net_bytes_sent, 0) / elapsed
        )
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
        name: _resource_rate_tracker.net_by_nic[name] for name in (net_per_nic or {}).keys()
    }

    if disk_io:
        read_bps = int(
            max(disk_io.read_bytes - _resource_rate_tracker.disk_read_bytes, 0) / elapsed
        )
        write_bps = int(
            max(disk_io.write_bytes - _resource_rate_tracker.disk_write_bytes, 0) / elapsed
        )
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
    mount_point = resolve_mount_point(SETTINGS.root_path)
    disk = psutil.disk_usage(mount_point)
    try:
        load_one, load_five, load_fifteen = os.getloadavg()
    except OSError:
        load_one = load_five = load_fifteen = 0.0

    cpu_count = os.cpu_count() or 1
    cpu_used_percent = psutil.cpu_percent(interval=None)
    load_ratio_percent = min((load_one / cpu_count) * 100, 100.0)
    network_stats, network_interfaces, disk_io_stats, disk_devices = sample_resource_rates()
    inode_stats = sample_inode_stats(mount_point)
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
            mount_point=mount_point,
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


def record_resource_history(
    snapshot: ResourceSnapshot | None = None,
    *,
    min_interval_seconds: int = 0,
) -> None:
    global _resource_history_last_epoch

    now_epoch = time.time()
    if min_interval_seconds and now_epoch - _resource_history_last_epoch < min_interval_seconds:
        return

    current_snapshot = snapshot or get_resource_snapshot()
    _persist_resource_snapshot(current_snapshot)
    _resource_history_last_epoch = now_epoch
    _prune_resource_history(now_epoch)


async def resource_sampler() -> None:
    while True:
        with suppress(Exception):
            record_resource_history(
                collect_resource_snapshot(),
                min_interval_seconds=SETTINGS.sample_interval_seconds,
            )
        await asyncio.sleep(SETTINGS.sample_interval_seconds)


async def on_startup() -> None:
    global _resource_sampler_task, _resource_history_last_epoch, _resource_prune_last_epoch

    psutil.cpu_percent(interval=None)
    _resource_history_last_epoch = 0.0
    _resource_prune_last_epoch = 0.0
    record_resource_history(collect_resource_snapshot())
    _resource_sampler_task = asyncio.create_task(resource_sampler())


async def on_shutdown() -> None:
    global _resource_sampler_task

    if _resource_sampler_task is None:
        return
    _resource_sampler_task.cancel()
    with suppress(asyncio.CancelledError):
        await _resource_sampler_task
    _resource_sampler_task = None


def get_resource_history(range_key: str | None = None) -> ResourceHistoryResponse:
    normalized_range, range_seconds = _resolve_history_range(range_key)
    range_start = _utc_datetime_now() - timedelta(seconds=range_seconds)
    records = storage.list_resource_samples(since=range_start.isoformat())

    if not records:
        snapshot = collect_resource_snapshot()
        record_resource_history(snapshot)
        records = storage.list_resource_samples(since=range_start.isoformat())

    points, resolution_seconds = _downsample_history_points(
        records,
        range_start=range_start,
        base_resolution_seconds=SETTINGS.sample_interval_seconds,
    )
    summary = _build_history_summary(
        records,
        range_start=range_start,
        base_resolution_seconds=SETTINGS.sample_interval_seconds,
    )

    return ResourceHistoryResponse(
        interval_seconds=SETTINGS.sample_interval_seconds,
        resolution_seconds=resolution_seconds,
        range_key=normalized_range,
        range_seconds=range_seconds,
        sampled_from=points[0].timestamp if points else None,
        sampled_to=points[-1].timestamp if points else None,
        point_count=len(points),
        points=points,
        summary=summary,
    )
