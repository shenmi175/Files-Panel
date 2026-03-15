from __future__ import annotations

import ipaddress
import json
import secrets
import subprocess
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from fastapi import HTTPException, status

from app.core import storage
from app.core.settings import SETTINGS
from app.models import (
    WireGuardBootstrapPrepareRequest,
    WireGuardBootstrapPrepareResponse,
    WireGuardBootstrapRegisterRequest,
    WireGuardBootstrapRegisterResponse,
    WireGuardBootstrapStatusResponse,
)
from app.services.access import helper_available, run_privileged_helper


WIREGUARD_INTERFACE_NAME = "wg0"
WIREGUARD_PERSISTENT_KEEPALIVE = 25


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso_datetime(raw_value: str) -> datetime:
    return datetime.fromisoformat(raw_value)


def _normalize_manager_url(raw_value: str) -> str:
    value = raw_value.strip().rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="manager url must include http/https and host")
    return value


def _normalize_endpoint_host(raw_value: str | None, *, manager_url: str) -> str:
    parsed = urlparse(manager_url)
    if raw_value and raw_value.strip():
        return raw_value.strip()
    if not parsed.hostname:
        raise HTTPException(status_code=400, detail="manager url hostname could not be resolved")
    return parsed.hostname


def _wireguard_status_payload() -> dict[str, object]:
    if not helper_available():
        raise HTTPException(status_code=500, detail="privileged helper is not installed")
    result = run_privileged_helper(
        ["wireguard-status", WIREGUARD_INTERFACE_NAME],
        "read wireguard status",
        allowed_returncodes={0, 4},
    )
    if result.returncode == 4:
        return {}
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail="wireguard status returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail="wireguard status returned an unexpected payload")
    return payload


def build_wireguard_bootstrap_status() -> WireGuardBootstrapStatusResponse:
    payload = _wireguard_status_payload()
    if not payload:
        return WireGuardBootstrapStatusResponse(
            available=False,
            interface_name=WIREGUARD_INTERFACE_NAME,
            message="wg0 is not configured on the manager yet",
        )

    manager_address = str(payload.get("address") or "")
    try:
        network = str(ipaddress.ip_interface(manager_address).network) if manager_address else None
        listen_port = int(payload["listen_port"]) if payload.get("listen_port") else None
    except (ValueError, ipaddress.AddressValueError) as exc:
        raise HTTPException(status_code=500, detail=f"invalid WireGuard status on manager: {exc}") from exc

    return WireGuardBootstrapStatusResponse(
        available=True,
        interface_name=WIREGUARD_INTERFACE_NAME,
        manager_address=manager_address or None,
        manager_network=network,
        public_key=str(payload.get("public_key") or "") or None,
        listen_port=listen_port,
        message="wg0 is ready for agent bootstrap",
    )


def prepare_wireguard_bootstrap(
    request: WireGuardBootstrapPrepareRequest,
) -> WireGuardBootstrapPrepareResponse:
    status_payload = build_wireguard_bootstrap_status()
    if not status_payload.available:
        raise HTTPException(status_code=400, detail=status_payload.message or "wg0 is not ready on the manager")

    manager_url = _normalize_manager_url(request.manager_url)
    endpoint_host = _normalize_endpoint_host(request.endpoint_host, manager_url=manager_url)
    expires_at = (_utc_now() + timedelta(minutes=request.expires_in_minutes)).isoformat()
    requested_name = (request.node_name or "").strip() or None
    _, raw_token = storage.create_wireguard_bootstrap_token(
        manager_url=manager_url,
        endpoint_host=endpoint_host,
        requested_name=requested_name,
        expires_at=expires_at,
    )

    install_command = "sudo bash scripts/install_agent_only.sh"
    bootstrap_command = (
        f"sudo file-panel bootstrap-wireguard --manager-url {manager_url} "
        f"--bootstrap-token {raw_token}"
    )
    if requested_name:
        quoted_name = requested_name.replace('"', '\\"')
        bootstrap_command += f' --node-name "{quoted_name}"'

    return WireGuardBootstrapPrepareResponse(
        message="bootstrap token generated",
        manager_url=manager_url,
        endpoint_host=endpoint_host,
        bootstrap_token=raw_token,
        expires_at=expires_at,
        install_command=install_command,
        bootstrap_command=bootstrap_command,
        combined_command=f"{install_command}\n{bootstrap_command}",
    )


def _allocate_wireguard_ip(network_cidr: str, manager_address: str) -> tuple[str, str]:
    network = ipaddress.ip_network(network_cidr, strict=False)
    manager_ip = ipaddress.ip_interface(manager_address).ip
    used_ips = {ipaddress.ip_address(manager_ip)}
    for raw_ip in storage.list_allocated_wireguard_ips():
        try:
            used_ips.add(ipaddress.ip_address(raw_ip))
        except ValueError:
            continue

    for host in network.hosts():
        if host == manager_ip or host in used_ips:
            continue
        return str(host), f"{host}/{network.prefixlen}"
    raise HTTPException(status_code=500, detail="no available WireGuard IP addresses remain in the configured subnet")


def register_wireguard_agent(
    payload: WireGuardBootstrapRegisterRequest,
    authorization: str | None = None,
) -> WireGuardBootstrapRegisterResponse:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="bootstrap token required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token_record = storage.load_wireguard_bootstrap_token(token)
    if token_record is None:
        raise HTTPException(status_code=401, detail="invalid bootstrap token")
    if token_record["used_at"]:
        raise HTTPException(status_code=409, detail="bootstrap token has already been used")
    if _parse_iso_datetime(token_record["expires_at"]) <= _utc_now():
        raise HTTPException(status_code=410, detail="bootstrap token has expired")
    if not payload.public_key.strip():
        raise HTTPException(status_code=400, detail="agent WireGuard public key is required")
    if not payload.agent_token.strip():
        raise HTTPException(status_code=400, detail="agent token is required")

    status_payload = build_wireguard_bootstrap_status()
    if not status_payload.available or not status_payload.manager_network or not status_payload.manager_address:
        raise HTTPException(status_code=400, detail="manager WireGuard interface is not ready")
    if not status_payload.listen_port:
        raise HTTPException(status_code=400, detail="manager WireGuard listen port is not configured")
    if not status_payload.public_key:
        raise HTTPException(status_code=400, detail="manager WireGuard public key is unavailable")

    wireguard_ip, address_cidr = _allocate_wireguard_ip(
        status_payload.manager_network,
        status_payload.manager_address,
    )

    run_privileged_helper(
        [
            "wireguard-add-peer",
            WIREGUARD_INTERFACE_NAME,
            payload.public_key.strip(),
            f"{wireguard_ip}/32",
            str(WIREGUARD_PERSISTENT_KEEPALIVE),
        ],
        "add WireGuard peer",
        timeout_seconds=30,
    )

    server_name = (payload.agent_name or "").strip() or token_record["requested_name"] or f"agent-{wireguard_ip}"
    base_url = f"http://{wireguard_ip}:{payload.agent_port}"
    server_id = storage.create_server(
        name=server_name,
        base_url=base_url,
        auth_token=payload.agent_token.strip(),
        wireguard_ip=wireguard_ip,
        enabled=True,
        is_local=False,
    )
    storage.mark_wireguard_bootstrap_token_used(
        token_record["id"],
        assigned_wireguard_ip=wireguard_ip,
        server_id=server_id,
    )

    return WireGuardBootstrapRegisterResponse(
        message="agent registered and WireGuard peer added",
        server_id=server_id,
        server_name=server_name,
        manager_url=token_record["manager_url"],
        wireguard_ip=wireguard_ip,
        address_cidr=address_cidr,
        network_cidr=status_payload.manager_network,
        endpoint=f"{token_record['endpoint_host']}:{status_payload.listen_port}",
        manager_public_key=status_payload.public_key or "",
        allowed_ips=status_payload.manager_network,
        persistent_keepalive=WIREGUARD_PERSISTENT_KEEPALIVE,
        base_url=base_url,
    )
