from __future__ import annotations

import ipaddress
import os
import secrets
import sqlite3
import subprocess
import sys
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_ENV_FILE = Path("/etc/files-agent/files-agent.env")
DEFAULT_DATABASE_PATH = Path("/var/lib/files-agent/file-panel.db")
HELPER_PATH = Path("/usr/local/libexec/file-panel/file-panel-helper.sh")
WIREGUARD_INTERFACE = "wg0"
DEFAULT_WIREGUARD_PORT = 51820
DEFAULT_KEEPALIVE = 25


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_env_values(path: Path) -> dict[str, str]:
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


def database_path(env_values: dict[str, str]) -> Path:
    raw_value = env_values.get("DATABASE_PATH")
    if raw_value:
        return Path(raw_value)
    return DEFAULT_DATABASE_PATH


def read_db_config(path: Path, key: str) -> str | None:
    if not path.exists():
        return None
    with sqlite3.connect(path) as connection:
        row = connection.execute(
            "SELECT value FROM config WHERE key = ? LIMIT 1",
            (key,),
        ).fetchone()
    if row is None:
        return None
    return str(row[0])


def write_db_config(path: Path, key: str, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as connection:
        connection.execute(
            """
            INSERT INTO config (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            """,
            (key, value, utc_now()),
        )


def config_value(env_values: dict[str, str], key: str, default: str = "") -> str:
    db_value = read_db_config(database_path(env_values), key)
    if db_value:
        return db_value
    return env_values.get(key, default)


def run_capture(command: list[str], *, input_text: str | None = None) -> str:
    result = subprocess.run(
        command,
        input=input_text,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"command failed: {' '.join(command)}"
        raise RuntimeError(detail)
    return result.stdout.strip()


def generate_wireguard_keypair() -> tuple[str, str]:
    private_key = run_capture(["wg", "genkey"])
    public_key = run_capture(["wg", "pubkey"], input_text=f"{private_key}\n")
    if not private_key or not public_key:
        raise RuntimeError("failed to generate WireGuard keypair")
    return private_key, public_key


def apply_wireguard_config(config_text: str) -> None:
    if not HELPER_PATH.exists():
        raise RuntimeError(f"privileged helper is not installed: {HELPER_PATH}")
    run_capture([str(HELPER_PATH), "replace-wireguard-config-stdin", WIREGUARD_INTERFACE], input_text=config_text)
    run_capture([str(HELPER_PATH), "enable-wireguard", WIREGUARD_INTERFACE])


def wireguard_config_path() -> Path:
    return Path(f"/etc/wireguard/{WIREGUARD_INTERFACE}.conf")


def prompt_text(
    label: str,
    *,
    default: str | None = None,
    allow_blank: bool = False,
    validator: Callable[[str], str] | None = None,
) -> str:
    while True:
        suffix = f" [{default}]" if default else ""
        raw = input(f"{label}{suffix}: ").strip()
        if not raw:
            if default is not None:
                raw = default
            elif allow_blank:
                return ""
            else:
                print("此项必填。")
                continue
        if validator is None:
            return raw
        try:
            return validator(raw)
        except ValueError as exc:
            print(f"输入无效: {exc}")


def prompt_yes_no(label: str, *, default: bool = False) -> bool:
    suffix = "Y/n" if default else "y/N"
    while True:
        raw = input(f"{label} [{suffix}]: ").strip().lower()
        if not raw:
            return default
        if raw in {"y", "yes"}:
            return True
        if raw in {"n", "no"}:
            return False
        print("请输入 y 或 n。")


def validate_host(value: str) -> str:
    if not value:
        raise ValueError("不能为空")
    return value


def validate_port(value: str) -> str:
    port = int(value)
    if port < 1 or port > 65535:
        raise ValueError("端口必须在 1-65535 之间")
    return str(port)


def validate_public_key(value: str) -> str:
    if len(value.strip()) < 20:
        raise ValueError("看起来不像合法的 WireGuard 公钥")
    return value.strip()


def validate_address_cidr(value: str) -> str:
    return str(ipaddress.ip_interface(value.strip()))


def validate_allowed_ips(value: str) -> str:
    segments = [segment.strip() for segment in value.split(",") if segment.strip()]
    if not segments:
        raise ValueError("至少填写一个 AllowedIPs")
    parsed_segments: list[str] = []
    for segment in segments:
        try:
            parsed_segments.append(str(ipaddress.ip_network(segment, strict=False)))
            continue
        except ValueError:
            pass
        try:
            parsed_segments.append(str(ipaddress.ip_address(segment)))
        except ValueError as exc:
            raise ValueError(f"无效的网段或地址: {segment}") from exc
    return ", ".join(parsed_segments)


def validate_dns(value: str) -> str:
    if not value.strip():
        return ""
    segments = [segment.strip() for segment in value.split(",") if segment.strip()]
    if not segments:
        return ""
    for segment in segments:
        ipaddress.ip_address(segment)
    return ", ".join(segments)


def infer_allowed_ips(address_cidr: str) -> str:
    return str(ipaddress.ip_interface(address_cidr).network)


def render_wireguard_config(
    *,
    private_key: str,
    address_cidr: str,
    dns: str | None,
    manager_public_key: str,
    endpoint: str,
    allowed_ips: str,
    persistent_keepalive: int,
) -> str:
    lines = [
        "[Interface]",
        f"Address = {address_cidr}",
        f"PrivateKey = {private_key}",
    ]
    if dns:
        lines.append(f"DNS = {dns}")
    lines.extend(
        [
            "",
            "[Peer]",
            f"PublicKey = {manager_public_key}",
            f"Endpoint = {endpoint}",
            f"AllowedIPs = {allowed_ips}",
            f"PersistentKeepalive = {persistent_keepalive}",
            "",
        ]
    )
    return "\n".join(lines)


def ensure_agent_token(env_values: dict[str, str], db_path: Path) -> tuple[str, bool]:
    token = config_value(env_values, "AGENT_TOKEN")
    if token:
        return token, False
    token = secrets.token_urlsafe(24)
    write_db_config(db_path, "AGENT_TOKEN", token)
    return token, True


def main() -> int:
    env_values = read_env_values(Path(os.getenv("ENV_FILE", str(DEFAULT_ENV_FILE))))
    role = env_values.get("FILE_PANEL_ROLE", "manager").strip().lower() or "manager"
    if role != "agent":
        raise RuntimeError("setup-agent is only available on agent-only nodes")

    db_path = database_path(env_values)
    agent_name = config_value(env_values, "AGENT_NAME", default=os.uname().nodename)
    agent_port = int(config_value(env_values, "PORT", default="3000") or "3000")
    agent_token, token_generated = ensure_agent_token(env_values, db_path)

    print()
    print("File Panel agent setup wizard")
    print("目标：配置这台主机的 WireGuard 内网连接，并输出可用于 manager 节点目录的接入信息。")
    print()

    config_path = wireguard_config_path()
    if config_path.exists():
        overwrite = prompt_yes_no(
            f"{config_path} 已存在，是否覆盖当前 WireGuard 配置",
            default=False,
        )
        if not overwrite:
            print("已取消。")
            return 1

    endpoint_host = prompt_text("manager 的 WireGuard 公网地址或域名", validator=validate_host)
    endpoint_port = prompt_text(
        "manager 的 WireGuard 监听端口",
        default=str(DEFAULT_WIREGUARD_PORT),
        validator=validate_port,
    )
    manager_public_key = prompt_text("manager 的 WireGuard 公钥", validator=validate_public_key)
    address_cidr = prompt_text(
        "分配给这台主机的 WireGuard 内网地址",
        validator=validate_address_cidr,
    )
    allowed_ips = prompt_text(
        "AllowedIPs",
        default=infer_allowed_ips(address_cidr),
        validator=validate_allowed_ips,
    )
    dns_value = prompt_text(
        "可选 DNS 服务器",
        allow_blank=True,
        validator=validate_dns,
    )

    print()
    print("请确认以下配置：")
    print(f"- 节点名称: {agent_name}")
    print(f"- Agent API 端口: {agent_port}")
    print(f"- WireGuard 地址: {address_cidr}")
    print(f"- Manager Endpoint: {endpoint_host}:{endpoint_port}")
    print(f"- AllowedIPs: {allowed_ips}")
    print(f"- DNS: {dns_value or '(不设置)'}")
    print()

    if not prompt_yes_no("确认写入并启动 wg0", default=True):
        print("已取消。")
        return 1

    private_key, public_key = generate_wireguard_keypair()
    config_text = render_wireguard_config(
        private_key=private_key,
        address_cidr=address_cidr,
        dns=dns_value or None,
        manager_public_key=manager_public_key,
        endpoint=f"{endpoint_host}:{endpoint_port}",
        allowed_ips=allowed_ips,
        persistent_keepalive=DEFAULT_KEEPALIVE,
    )
    apply_wireguard_config(config_text)

    wireguard_ip = str(ipaddress.ip_interface(address_cidr).ip)
    print()
    print("配置完成")
    print(f"本机 WireGuard 公钥: {public_key}")
    print(f"本机 WireGuard IP: {wireguard_ip}")
    print(f"本机 Agent URL: http://{wireguard_ip}:{agent_port}")
    print(f"本机 AGENT_TOKEN: {agent_token}")
    if token_generated:
        print("注意: 该 token 是本次新生成的。请执行 'sudo file-panel restart' 让 agent 进程加载新 token。")
    print()
    print("下一步：回到 manager 面板的“节点”页，手动填写以下信息：")
    print(f"- 节点名称: {agent_name}")
    print(f"- WireGuard IP: {wireguard_ip}")
    print(f"- 节点 Token: {agent_token}")
    print(f"- URL: http://{wireguard_ip}:{agent_port}  （可留空，manager 会默认按 WireGuard IP 拼接）")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"setup failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
