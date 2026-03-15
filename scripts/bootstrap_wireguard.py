from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path
from urllib import error, request


DEFAULT_ENV_FILE = Path("/etc/files-agent/files-agent.env")
DEFAULT_DATABASE_PATH = Path("/var/lib/files-agent/file-panel.db")
HELPER_PATH = Path("/usr/local/libexec/file-panel/file-panel-helper.sh")
WIREGUARD_INTERFACE = "wg0"


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


def register_with_manager(
    *,
    manager_url: str,
    bootstrap_token: str,
    agent_name: str,
    agent_token: str,
    public_key: str,
    agent_port: int,
) -> dict[str, object]:
    payload = json.dumps(
        {
            "agent_name": agent_name,
            "agent_token": agent_token,
            "public_key": public_key,
            "agent_port": agent_port,
        }
    ).encode("utf-8")
    http_request = request.Request(
        f"{manager_url.rstrip('/')}/api/bootstrap/wireguard/register",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {bootstrap_token}",
        },
        method="POST",
    )
    try:
        with request.urlopen(http_request, timeout=30) as response:
            raw_body = response.read()
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace").strip() or exc.reason
        raise RuntimeError(f"manager rejected bootstrap request: {detail}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"failed to reach manager: {exc.reason}") from exc

    try:
        parsed = json.loads(raw_body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError("manager returned invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("manager returned an unexpected bootstrap response")
    return parsed


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


def apply_wireguard_config(config_text: str) -> None:
    if not HELPER_PATH.exists():
        raise RuntimeError(f"privileged helper is not installed: {HELPER_PATH}")
    run_capture([str(HELPER_PATH), "replace-wireguard-config-stdin", WIREGUARD_INTERFACE], input_text=config_text)
    run_capture([str(HELPER_PATH), "enable-wireguard", WIREGUARD_INTERFACE])


def existing_wireguard_config_path() -> Path:
    return Path(f"/etc/wireguard/{WIREGUARD_INTERFACE}.conf")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Bootstrap this node into the manager WireGuard network.")
    parser.add_argument("--manager-url", required=True, help="Manager public URL, for example https://panel.example.com")
    parser.add_argument("--bootstrap-token", required=True, help="One-time bootstrap token generated on the manager")
    parser.add_argument("--node-name", default="", help="Optional node name override")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    env_values = read_env_values(Path(os.getenv("ENV_FILE", str(DEFAULT_ENV_FILE))))
    role = env_values.get("FILE_PANEL_ROLE", "manager").strip().lower() or "manager"
    if role != "agent":
        raise RuntimeError("bootstrap-wireguard is intended for agent-only nodes")

    config_path = existing_wireguard_config_path()
    if config_path.exists():
        raise RuntimeError(f"{config_path} already exists; remove or back it up before bootstrapping again")

    agent_name = (args.node_name or "").strip() or config_value(env_values, "AGENT_NAME", default=os.uname().nodename)
    agent_token = config_value(env_values, "AGENT_TOKEN")
    if not agent_token:
        raise RuntimeError("AGENT_TOKEN is not configured on this node")

    agent_port = int(config_value(env_values, "PORT", default="3000") or "3000")
    private_key, public_key = generate_wireguard_keypair()
    payload = register_with_manager(
        manager_url=args.manager_url,
        bootstrap_token=args.bootstrap_token,
        agent_name=agent_name,
        agent_token=agent_token,
        public_key=public_key,
        agent_port=agent_port,
    )

    config_text = render_wireguard_config(
        private_key=private_key,
        address_cidr=str(payload["address_cidr"]),
        dns=str(payload.get("dns") or "") or None,
        manager_public_key=str(payload["manager_public_key"]),
        endpoint=str(payload["endpoint"]),
        allowed_ips=str(payload["allowed_ips"]),
        persistent_keepalive=int(payload["persistent_keepalive"]),
    )
    apply_wireguard_config(config_text)

    print()
    print("WireGuard bootstrap complete")
    print(f"Node name: {payload['server_name']}")
    print(f"WireGuard IP: {payload['wireguard_ip']}")
    print(f"Agent URL: {payload['base_url']}")
    print(f"Manager URL: {payload['manager_url']}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"bootstrap failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
