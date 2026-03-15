from __future__ import annotations

import json
import os
import hashlib
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_STATE_DIR = Path("/var/lib/files-agent")
DEFAULT_ENV_FILE_PATH = Path("/etc/files-agent/files-agent.env")
DEFAULT_DATABASE_NAME = "file-panel.db"
LEGACY_ACCESS_STATE_FILE = "access.json"
CONFIG_KEYS = (
    "HOST",
    "PORT",
    "AGENT_NAME",
    "AGENT_ROOT",
    "AGENT_TOKEN",
    "RESOURCE_SAMPLE_INTERVAL",
    "SYSTEM_READONLY_PATHS",
    "CERTBOT_EMAIL",
    "ALLOW_SELF_RESTART",
)
RESOURCE_SAMPLE_FIELDS = (
    "sampled_at",
    "cpu_used_percent",
    "memory_used_percent",
    "disk_used_percent",
    "load_ratio_percent",
    "network_download_bps",
    "network_upload_bps",
    "disk_read_bps",
    "disk_write_bps",
)


@dataclass(frozen=True)
class BootstrapPaths:
    env_file_path: Path
    state_dir: Path
    database_path: Path


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def bootstrap_paths() -> BootstrapPaths:
    state_dir = Path(os.getenv("STATE_DIR", str(DEFAULT_STATE_DIR))).expanduser()
    env_file_path = Path(os.getenv("ENV_FILE_PATH", str(DEFAULT_ENV_FILE_PATH))).expanduser()
    database_path = Path(
        os.getenv("DATABASE_PATH", str(state_dir / DEFAULT_DATABASE_NAME))
    ).expanduser()
    return BootstrapPaths(
        env_file_path=env_file_path,
        state_dir=state_dir,
        database_path=database_path,
    )


def read_legacy_env_file(path: Path) -> dict[str, str]:
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


def connect() -> sqlite3.Connection:
    paths = bootstrap_paths()
    paths.state_dir.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(paths.database_path, timeout=10, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=5000")
    return connection


def initialize_storage(default_config: dict[str, str] | None = None) -> None:
    paths = bootstrap_paths()
    legacy_env = read_legacy_env_file(paths.env_file_path)
    seed_config = {
        key: value
        for key, value in {**(default_config or {}), **legacy_env}.items()
        if key in CONFIG_KEYS and value is not None
    }

    with connect() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS access_state (
                singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
                domain TEXT,
                public_url TEXT,
                https_enabled INTEGER NOT NULL DEFAULT 0,
                configured_at TEXT
            );

            CREATE TABLE IF NOT EXISTS admin_account (
                singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
                username TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS servers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                base_url TEXT,
                auth_token TEXT,
                wireguard_ip TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                is_local INTEGER NOT NULL DEFAULT 0,
                last_seen_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_single_local
            ON servers (is_local)
            WHERE is_local = 1;

            CREATE TABLE IF NOT EXISTS resource_samples (
                sampled_at TEXT PRIMARY KEY,
                cpu_used_percent REAL NOT NULL,
                memory_used_percent REAL NOT NULL,
                disk_used_percent REAL NOT NULL,
                load_ratio_percent REAL NOT NULL,
                network_download_bps INTEGER NOT NULL,
                network_upload_bps INTEGER NOT NULL,
                disk_read_bps INTEGER NOT NULL,
                disk_write_bps INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS wireguard_bootstrap_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token_hash TEXT NOT NULL UNIQUE,
                manager_url TEXT NOT NULL,
                endpoint_host TEXT NOT NULL,
                requested_name TEXT,
                expires_at TEXT NOT NULL,
                used_at TEXT,
                assigned_wireguard_ip TEXT,
                server_id INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )

        existing_keys = {
            str(row["key"])
            for row in connection.execute("SELECT key FROM config")
        }
        now = utc_now()
        for key, value in seed_config.items():
            if key in existing_keys:
                continue
            connection.execute(
                "INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)",
                (key, str(value), now),
            )

        access_row = connection.execute(
            "SELECT 1 FROM access_state WHERE singleton_id = 1"
        ).fetchone()
        legacy_access_path = paths.state_dir / LEGACY_ACCESS_STATE_FILE
        if access_row is None and legacy_access_path.exists():
            try:
                payload = json.loads(legacy_access_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                payload = {}
            if payload:
                connection.execute(
                    """
                    INSERT INTO access_state (
                        singleton_id,
                        domain,
                        public_url,
                        https_enabled,
                        configured_at
                    ) VALUES (1, ?, ?, ?, ?)
                    """,
                    (
                        payload.get("domain"),
                        payload.get("public_url"),
                        1 if payload.get("https_enabled") else 0,
                        payload.get("configured_at"),
                    ),
                )
        elif access_row is None and legacy_env.get("PUBLIC_DOMAIN"):
            domain = legacy_env["PUBLIC_DOMAIN"].strip()
            if domain:
                connection.execute(
                    """
                    INSERT INTO access_state (
                        singleton_id,
                        domain,
                        public_url,
                        https_enabled,
                        configured_at
                    ) VALUES (1, ?, ?, 1, ?)
                    """,
                    (domain, f"https://{domain}", utc_now()),
                )


def load_config_values() -> dict[str, str]:
    with connect() as connection:
        rows = connection.execute("SELECT key, value FROM config").fetchall()
    return {str(row["key"]): str(row["value"]) for row in rows}


def save_config_values(values: dict[str, Any]) -> None:
    now = utc_now()
    with connect() as connection:
        for key, value in values.items():
            if key not in CONFIG_KEYS or value is None:
                continue
            connection.execute(
                """
                INSERT INTO config (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                """,
                (key, str(value), now),
            )


def load_access_state() -> dict[str, Any]:
    with connect() as connection:
        row = connection.execute(
            """
            SELECT domain, public_url, https_enabled, configured_at
            FROM access_state
            WHERE singleton_id = 1
            """
        ).fetchone()
    if row is None:
        return {}
    return {
        "domain": row["domain"],
        "public_url": row["public_url"],
        "https_enabled": bool(row["https_enabled"]),
        "configured_at": row["configured_at"],
    }


def save_access_state(payload: dict[str, Any]) -> None:
    with connect() as connection:
        connection.execute(
            """
            INSERT INTO access_state (
                singleton_id,
                domain,
                public_url,
                https_enabled,
                configured_at
            )
            VALUES (1, ?, ?, ?, ?)
            ON CONFLICT(singleton_id) DO UPDATE SET
                domain = excluded.domain,
                public_url = excluded.public_url,
                https_enabled = excluded.https_enabled,
                configured_at = excluded.configured_at
            """,
            (
                payload.get("domain"),
                payload.get("public_url"),
                1 if payload.get("https_enabled") else 0,
                payload.get("configured_at"),
            ),
        )


def load_admin_account() -> dict[str, Any] | None:
    with connect() as connection:
        row = connection.execute(
            """
            SELECT
                username,
                password_hash,
                password_salt,
                created_at,
                updated_at
            FROM admin_account
            WHERE singleton_id = 1
            """
        ).fetchone()
    if row is None:
        return None
    return {
        "username": str(row["username"]),
        "password_hash": str(row["password_hash"]),
        "password_salt": str(row["password_salt"]),
        "created_at": str(row["created_at"]),
        "updated_at": str(row["updated_at"]),
    }


def admin_account_exists() -> bool:
    return load_admin_account() is not None


def save_admin_account(*, username: str, password_hash: str, password_salt: str) -> None:
    now = utc_now()
    with connect() as connection:
        existing_created_at = connection.execute(
            "SELECT created_at FROM admin_account WHERE singleton_id = 1"
        ).fetchone()
        created_at = str(existing_created_at["created_at"]) if existing_created_at else now
        connection.execute(
            """
            INSERT INTO admin_account (
                singleton_id,
                username,
                password_hash,
                password_salt,
                created_at,
                updated_at
            ) VALUES (1, ?, ?, ?, ?, ?)
            ON CONFLICT(singleton_id) DO UPDATE SET
                username = excluded.username,
                password_hash = excluded.password_hash,
                password_salt = excluded.password_salt,
                updated_at = excluded.updated_at
            """,
            (username, password_hash, password_salt, created_at, now),
        )


def list_servers() -> list[dict[str, Any]]:
    with connect() as connection:
        rows = connection.execute(
            """
            SELECT
                id,
                name,
                base_url,
                wireguard_ip,
                enabled,
                is_local,
                last_seen_at,
                created_at,
                updated_at
            FROM servers
            ORDER BY is_local DESC, name COLLATE NOCASE ASC, id ASC
            """
        ).fetchall()
    return [
        {
            "id": int(row["id"]),
            "name": str(row["name"]),
            "base_url": row["base_url"],
            "wireguard_ip": row["wireguard_ip"],
            "enabled": bool(row["enabled"]),
            "is_local": bool(row["is_local"]),
            "last_seen_at": row["last_seen_at"],
            "created_at": str(row["created_at"]),
            "updated_at": str(row["updated_at"]),
        }
        for row in rows
    ]


def load_server_by_id(server_id: int) -> dict[str, Any] | None:
    with connect() as connection:
        row = connection.execute(
            """
            SELECT
                id,
                name,
                base_url,
                auth_token,
                wireguard_ip,
                enabled,
                is_local,
                last_seen_at,
                created_at,
                updated_at
            FROM servers
            WHERE id = ?
            """,
            (server_id,),
        ).fetchone()
    if row is None:
        return None
    return {
        "id": int(row["id"]),
        "name": str(row["name"]),
        "base_url": row["base_url"],
        "auth_token": row["auth_token"],
        "wireguard_ip": row["wireguard_ip"],
        "enabled": bool(row["enabled"]),
        "is_local": bool(row["is_local"]),
        "last_seen_at": row["last_seen_at"],
        "created_at": str(row["created_at"]),
        "updated_at": str(row["updated_at"]),
    }


def create_server(
    *,
    name: str,
    base_url: str | None,
    auth_token: str | None,
    wireguard_ip: str | None,
    enabled: bool,
    is_local: bool = False,
) -> int:
    now = utc_now()
    with connect() as connection:
        cursor = connection.execute(
            """
            INSERT INTO servers (
                name,
                base_url,
                auth_token,
                wireguard_ip,
                enabled,
                is_local,
                last_seen_at,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                name,
                base_url,
                auth_token,
                wireguard_ip,
                1 if enabled else 0,
                1 if is_local else 0,
                None,
                now,
                now,
            ),
        )
        return int(cursor.lastrowid)


def update_server(
    server_id: int,
    *,
    name: str,
    base_url: str | None,
    auth_token: str | None,
    wireguard_ip: str | None,
    enabled: bool,
) -> None:
    with connect() as connection:
        connection.execute(
            """
            UPDATE servers
            SET
                name = ?,
                base_url = ?,
                auth_token = COALESCE(?, auth_token),
                wireguard_ip = ?,
                enabled = ?,
                updated_at = ?
            WHERE id = ? AND is_local = 0
            """,
            (
                name,
                base_url,
                auth_token,
                wireguard_ip,
                1 if enabled else 0,
                utc_now(),
                server_id,
            ),
        )


def delete_server(server_id: int) -> None:
    with connect() as connection:
        connection.execute(
            "DELETE FROM servers WHERE id = ? AND is_local = 0",
            (server_id,),
        )


def touch_server_last_seen(server_id: int, *, last_seen_at: str | None = None) -> None:
    with connect() as connection:
        connection.execute(
            """
            UPDATE servers
            SET
                last_seen_at = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (last_seen_at or utc_now(), utc_now(), server_id),
        )


def update_server_auth_token(server_id: int, auth_token: str | None) -> None:
    with connect() as connection:
        connection.execute(
            """
            UPDATE servers
            SET
                auth_token = ?,
                updated_at = ?
            WHERE id = ? AND is_local = 0
            """,
            (auth_token, utc_now(), server_id),
        )


def upsert_local_server(
    *,
    name: str,
    base_url: str | None,
    wireguard_ip: str | None = None,
    last_seen_at: str | None = None,
) -> None:
    now = utc_now()
    with connect() as connection:
        existing = connection.execute(
            "SELECT id FROM servers WHERE is_local = 1"
        ).fetchone()
        if existing is None:
            connection.execute(
                """
                INSERT INTO servers (
                    name,
                    base_url,
                    auth_token,
                    wireguard_ip,
                    enabled,
                    is_local,
                    last_seen_at,
                    created_at,
                    updated_at
                ) VALUES (?, ?, NULL, ?, 1, 1, ?, ?, ?)
                """,
                (name, base_url, wireguard_ip, last_seen_at or now, now, now),
            )
            return

        connection.execute(
            """
            UPDATE servers
            SET
                name = ?,
                base_url = ?,
                wireguard_ip = ?,
                enabled = 1,
                last_seen_at = ?,
                updated_at = ?
            WHERE is_local = 1
            """,
            (name, base_url, wireguard_ip, last_seen_at or now, now),
        )


def save_resource_sample(values: dict[str, Any]) -> None:
    payload = {key: values[key] for key in RESOURCE_SAMPLE_FIELDS}
    with connect() as connection:
        connection.execute(
            """
            INSERT INTO resource_samples (
                sampled_at,
                cpu_used_percent,
                memory_used_percent,
                disk_used_percent,
                load_ratio_percent,
                network_download_bps,
                network_upload_bps,
                disk_read_bps,
                disk_write_bps
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(sampled_at) DO UPDATE SET
                cpu_used_percent = excluded.cpu_used_percent,
                memory_used_percent = excluded.memory_used_percent,
                disk_used_percent = excluded.disk_used_percent,
                load_ratio_percent = excluded.load_ratio_percent,
                network_download_bps = excluded.network_download_bps,
                network_upload_bps = excluded.network_upload_bps,
                disk_read_bps = excluded.disk_read_bps,
                disk_write_bps = excluded.disk_write_bps
            """,
            tuple(payload[key] for key in RESOURCE_SAMPLE_FIELDS),
        )


def list_resource_samples(
    *,
    since: str | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    query = [
        """
        SELECT
            sampled_at,
            cpu_used_percent,
            memory_used_percent,
            disk_used_percent,
            load_ratio_percent,
            network_download_bps,
            network_upload_bps,
            disk_read_bps,
            disk_write_bps
        FROM resource_samples
        """
    ]
    parameters: list[Any] = []
    if since:
        query.append("WHERE sampled_at >= ?")
        parameters.append(since)
    query.append("ORDER BY sampled_at ASC")
    if limit is not None:
        query.append("LIMIT ?")
        parameters.append(limit)

    with connect() as connection:
        rows = connection.execute(" ".join(query), tuple(parameters)).fetchall()

    return [
        {
            "sampled_at": str(row["sampled_at"]),
            "cpu_used_percent": float(row["cpu_used_percent"]),
            "memory_used_percent": float(row["memory_used_percent"]),
            "disk_used_percent": float(row["disk_used_percent"]),
            "load_ratio_percent": float(row["load_ratio_percent"]),
            "network_download_bps": int(row["network_download_bps"]),
            "network_upload_bps": int(row["network_upload_bps"]),
            "disk_read_bps": int(row["disk_read_bps"]),
            "disk_write_bps": int(row["disk_write_bps"]),
        }
        for row in rows
    ]


def prune_resource_samples(before: str) -> None:
    with connect() as connection:
        connection.execute(
            "DELETE FROM resource_samples WHERE sampled_at < ?",
            (before,),
        )


def _hash_bootstrap_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_wireguard_bootstrap_token(
    *,
    manager_url: str,
    endpoint_host: str,
    requested_name: str | None,
    expires_at: str,
) -> tuple[int, str]:
    raw_token = secrets.token_urlsafe(24)
    token_hash = _hash_bootstrap_token(raw_token)
    now = utc_now()
    with connect() as connection:
        cursor = connection.execute(
            """
            INSERT INTO wireguard_bootstrap_tokens (
                token_hash,
                manager_url,
                endpoint_host,
                requested_name,
                expires_at,
                used_at,
                assigned_wireguard_ip,
                server_id,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
            """,
            (token_hash, manager_url, endpoint_host, requested_name, expires_at, now, now),
        )
        return int(cursor.lastrowid), raw_token


def load_wireguard_bootstrap_token(raw_token: str) -> dict[str, Any] | None:
    token_hash = _hash_bootstrap_token(raw_token)
    with connect() as connection:
        row = connection.execute(
            """
            SELECT
                id,
                manager_url,
                endpoint_host,
                requested_name,
                expires_at,
                used_at,
                assigned_wireguard_ip,
                server_id,
                created_at,
                updated_at
            FROM wireguard_bootstrap_tokens
            WHERE token_hash = ?
            """,
            (token_hash,),
        ).fetchone()
    if row is None:
        return None
    return {
        "id": int(row["id"]),
        "manager_url": str(row["manager_url"]),
        "endpoint_host": str(row["endpoint_host"]),
        "requested_name": str(row["requested_name"]) if row["requested_name"] else None,
        "expires_at": str(row["expires_at"]),
        "used_at": str(row["used_at"]) if row["used_at"] else None,
        "assigned_wireguard_ip": str(row["assigned_wireguard_ip"]) if row["assigned_wireguard_ip"] else None,
        "server_id": int(row["server_id"]) if row["server_id"] is not None else None,
        "created_at": str(row["created_at"]),
        "updated_at": str(row["updated_at"]),
    }


def mark_wireguard_bootstrap_token_used(
    token_id: int,
    *,
    assigned_wireguard_ip: str,
    server_id: int,
) -> None:
    now = utc_now()
    with connect() as connection:
        connection.execute(
            """
            UPDATE wireguard_bootstrap_tokens
            SET
                used_at = ?,
                assigned_wireguard_ip = ?,
                server_id = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (now, assigned_wireguard_ip, server_id, now, token_id),
        )


def list_allocated_wireguard_ips() -> list[str]:
    with connect() as connection:
        rows = connection.execute(
            """
            SELECT wireguard_ip AS ip_value
            FROM servers
            WHERE wireguard_ip IS NOT NULL AND wireguard_ip != ''
            UNION
            SELECT assigned_wireguard_ip AS ip_value
            FROM wireguard_bootstrap_tokens
            WHERE assigned_wireguard_ip IS NOT NULL AND assigned_wireguard_ip != ''
            """
        ).fetchall()
    return [str(row["ip_value"]) for row in rows if row["ip_value"]]
