from __future__ import annotations

import os
import secrets
import sqlite3
import shlex
import subprocess
from pathlib import Path

from fastapi import HTTPException

from app.core.settings import DOMAIN_PATTERN, SETTINGS, normalize_resource_sample_interval
from app.core.storage import load_access_state, load_config_values, save_access_state, save_config_values
from app.models import (
    AccessStatus,
    ConfigResponse,
    ConfigUpdateRequest,
    ConfigUpdateResponse,
    DomainSetupRequest,
    DomainSetupResponse,
    TokenResetResponse,
)
from app.services.common import (
    command_available,
    env_flag,
    is_public_bind,
    normalize_directory_path,
    normalize_existing_directory,
    runtime_restart_needed,
    utc_now,
)


COMMAND_TIMEOUT_SECONDS = 15
CERTBOT_TIMEOUT_SECONDS = 300
SERVICE_RESTART_DELAY_SECONDS = 5
PRIVILEGED_HELPER_PATH = os.getenv(
    "PRIVILEGED_HELPER_PATH",
    "/usr/local/libexec/file-panel/file-panel-helper.sh",
)


def default_config_values() -> dict[str, str]:
    return {
        "HOST": SETTINGS.host,
        "PORT": str(SETTINGS.port),
        "AGENT_NAME": SETTINGS.agent_name,
        "AGENT_ROOT": str(SETTINGS.root_path),
        "AGENT_TOKEN": SETTINGS.auth_token or "",
        "RESOURCE_SAMPLE_INTERVAL": str(SETTINGS.sample_interval_seconds),
        "CERTBOT_EMAIL": SETTINGS.certbot_email or "",
        "ALLOW_SELF_RESTART": "1" if SETTINGS.allow_self_restart else "0",
    }


def persisted_config_values() -> dict[str, str]:
    return {**default_config_values(), **load_config_values()}


def generate_agent_token() -> str:
    return secrets.token_urlsafe(32)


def run_command(command: list[str], action: str, *, timeout_seconds: int = COMMAND_TIMEOUT_SECONDS) -> None:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail=f"timed out while attempting to {action}") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to {action}: {exc}") from exc

    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"failed to {action}"
        raise HTTPException(status_code=500, detail=detail)


def helper_available() -> bool:
    helper_path = Path(PRIVILEGED_HELPER_PATH)
    return command_available("sudo") and helper_path.is_file() and os.access(helper_path, os.X_OK)


def run_privileged_helper(
    args: list[str],
    action: str,
    *,
    input_text: str | None = None,
    timeout_seconds: int = COMMAND_TIMEOUT_SECONDS,
    allowed_returncodes: set[int] | None = None,
) -> subprocess.CompletedProcess[str]:
    if allowed_returncodes is None:
        allowed_returncodes = {0}
    if not helper_available():
        raise HTTPException(status_code=500, detail="privileged helper is not installed")

    try:
        result = subprocess.run(
            ["sudo", "-n", PRIVILEGED_HELPER_PATH, *args],
            input=input_text,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail=f"timed out while attempting to {action}") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to {action}: {exc}") from exc

    if result.returncode not in allowed_returncodes:
        detail = result.stderr.strip() or result.stdout.strip() or f"failed to {action}"
        raise HTTPException(status_code=500, detail=detail)
    return result


def service_is_active(service_name: str | None) -> bool:
    if not service_name or not command_available("systemctl"):
        return False

    try:
        result = subprocess.run(
            ["systemctl", "is-active", service_name],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except (subprocess.TimeoutExpired, OSError):
        return False
    return result.returncode == 0 and result.stdout.strip() == "active"


def normalize_domain(raw_domain: str) -> str:
    normalized = raw_domain.strip().lower().rstrip(".")
    if not normalized or not DOMAIN_PATTERN.fullmatch(normalized):
        raise HTTPException(status_code=400, detail="invalid domain")
    return normalized


def tls_ready_for(domain: str | None, state: dict[str, object]) -> bool:
    if not domain:
        return False

    letsencrypt_cert = Path("/etc/letsencrypt/live") / domain / "fullchain.pem"
    try:
        if letsencrypt_cert.exists():
            return True
    except PermissionError:
        # The agent may run as an unprivileged service user without access to
        # certbot-managed directories; fall back to persisted access state.
        return bool(state.get("https_enabled"))
    return bool(state.get("https_enabled"))


def remove_nginx_site(domain: str) -> None:
    run_privileged_helper(["remove-nginx-site", domain], "remove nginx site")


def read_nginx_site_content(domain: str) -> str | None:
    result = run_privileged_helper(
        ["read-nginx-site", domain],
        "read nginx site",
        allowed_returncodes={0, 4},
    )
    if result.returncode == 4:
        return None
    return result.stdout


def write_nginx_site(domain: str, upstream_port: int) -> None:
    run_privileged_helper(
        ["write-nginx-site", domain, str(upstream_port)],
        "write nginx site",
    )


def restore_nginx_site(domain: str, content: str) -> None:
    run_privileged_helper(
        ["replace-nginx-site-stdin", domain],
        "restore nginx site",
        input_text=content,
    )


def schedule_service_restart(service_name: str | None, *, allow_restart: bool | None = None) -> bool:
    if allow_restart is None:
        allow_restart = SETTINGS.allow_self_restart
    if (
        not allow_restart
        or not service_name
        or service_name != (SETTINGS.agent_service_name or "files-agent")
        or not helper_available()
    ):
        return False

    subprocess.Popen(
        [
            "/bin/sh",
            "-c",
            "sleep "
            f"{SERVICE_RESTART_DELAY_SECONDS} && sudo -n {shlex.quote(PRIVILEGED_HELPER_PATH)} "
            "restart-agent >/dev/null 2>&1",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return True


def ensure_agent_root_access(agent_root: Path) -> None:
    if os.access(agent_root, os.R_OK | os.W_OK | os.X_OK):
        return
    if not helper_available():
        raise HTTPException(
            status_code=400,
            detail="agent root is not accessible by the service user and privileged helper is unavailable",
        )

    try:
        run_privileged_helper(
            ["grant-path-access", str(agent_root)],
            "grant service access to agent root",
            timeout_seconds=120,
        )
    except HTTPException as exc:
        detail = str(exc.detail or "")
        if "refusing to grant access" in detail or "sensitive path" in detail:
            raise HTTPException(status_code=400, detail=detail) from exc
        raise

    if not os.access(agent_root, os.R_OK | os.W_OK | os.X_OK):
        raise HTTPException(
            status_code=500,
            detail="agent root access could not be granted to the service user",
        )


def build_access_status() -> AccessStatus:
    config_values = persisted_config_values()
    state = load_access_state()

    desired_host = config_values.get("HOST", SETTINGS.host)
    desired_port = int(config_values.get("PORT", SETTINGS.port))
    domain = state.get("domain") or None
    https_enabled = tls_ready_for(str(domain) if domain else None, state)
    public_url = (
        f"https://{domain}"
        if domain and https_enabled
        else (f"http://{domain}" if domain else None)
    )

    return AccessStatus(
        current_bind_host=SETTINGS.host,
        current_bind_port=SETTINGS.port,
        desired_bind_host=desired_host,
        desired_bind_port=desired_port,
        public_ip_access_enabled=is_public_bind(desired_host),
        domain=str(domain) if domain else None,
        public_url=public_url,
        nginx_available=command_available("nginx"),
        nginx_running=service_is_active(SETTINGS.nginx_service_name),
        certbot_available=command_available("certbot"),
        https_enabled=https_enabled,
        token_configured=bool(config_values.get("AGENT_TOKEN")),
        restart_pending=runtime_restart_needed(config_values),
    )


def build_config_response() -> ConfigResponse:
    config_values = persisted_config_values()
    desired_host = config_values.get("HOST", SETTINGS.host)
    desired_port = int(config_values.get("PORT", SETTINGS.port))
    desired_sample_interval = normalize_resource_sample_interval(
        config_values.get("RESOURCE_SAMPLE_INTERVAL"),
        fallback=SETTINGS.sample_interval_seconds,
    )
    public_domain = load_access_state().get("domain") or None
    return ConfigResponse(
        agent_name=config_values.get("AGENT_NAME", SETTINGS.agent_name),
        agent_root=config_values.get("AGENT_ROOT", str(SETTINGS.root_path)),
        port=desired_port,
        resource_sample_interval=desired_sample_interval,
        allow_public_ip=is_public_bind(desired_host),
        certbot_email=config_values.get("CERTBOT_EMAIL") or None,
        allow_self_restart=env_flag(
            config_values.get("ALLOW_SELF_RESTART"),
            default=SETTINGS.allow_self_restart,
        ),
        public_domain=str(public_domain) if public_domain else None,
        token_configured=bool(config_values.get("AGENT_TOKEN")),
        auth_enabled=bool(SETTINGS.auth_token),
        current_bind_host=SETTINGS.host,
        current_bind_port=SETTINGS.port,
        desired_bind_host=desired_host,
        desired_bind_port=desired_port,
        restart_pending=runtime_restart_needed(config_values),
        database_path=str(SETTINGS.database_path),
    )


def update_config(request: ConfigUpdateRequest) -> ConfigUpdateResponse:
    config_values = persisted_config_values()
    agent_name = request.agent_name.strip()
    if not agent_name:
        raise HTTPException(status_code=400, detail="agent name is required")

    agent_root = normalize_directory_path(request.agent_root)
    ensure_agent_root_access(agent_root)
    agent_root = normalize_existing_directory(str(agent_root))
    certbot_email = (request.certbot_email or "").strip()
    allow_public_ip = bool(request.allow_public_ip)
    allow_self_restart = bool(request.allow_self_restart)
    next_token = (request.agent_token or "").strip()

    config_values["AGENT_NAME"] = agent_name
    config_values["AGENT_ROOT"] = str(agent_root)
    config_values["PORT"] = str(request.port)
    config_values["HOST"] = "0.0.0.0" if allow_public_ip else "127.0.0.1"
    config_values["CERTBOT_EMAIL"] = certbot_email
    config_values["ALLOW_SELF_RESTART"] = "1" if allow_self_restart else "0"
    if next_token:
        config_values["AGENT_TOKEN"] = next_token

    try:
        save_config_values(config_values)
    except (OSError, sqlite3.Error) as exc:
        raise HTTPException(status_code=500, detail=f"failed to persist config: {exc}") from exc

    restart_required = runtime_restart_needed(config_values)
    restart_scheduled = False
    if restart_required:
        restart_scheduled = schedule_service_restart(
            SETTINGS.agent_service_name,
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


def reset_agent_token() -> TokenResetResponse:
    config_values = persisted_config_values()
    next_token = generate_agent_token()
    allow_self_restart = env_flag(
        config_values.get("ALLOW_SELF_RESTART"),
        default=SETTINGS.allow_self_restart,
    )
    config_values["AGENT_TOKEN"] = next_token

    try:
        save_config_values(config_values)
    except (OSError, sqlite3.Error) as exc:
        raise HTTPException(status_code=500, detail=f"failed to persist config: {exc}") from exc

    restart_required = runtime_restart_needed(config_values)
    restart_scheduled = False
    if restart_required:
        restart_scheduled = schedule_service_restart(
            SETTINGS.agent_service_name,
            allow_restart=allow_self_restart,
        )

    message = "agent token has been rotated"
    if restart_required and restart_scheduled:
        message = "agent token has been rotated; agent restart has been scheduled"
    elif restart_required:
        message = "agent token has been rotated; restart required to apply changes"

    return TokenResetResponse(
        message=message,
        token=next_token,
        restart_required=restart_required,
        restart_scheduled=restart_scheduled,
        config=build_config_response(),
    )


def configure_domain_access(request: DomainSetupRequest) -> DomainSetupResponse:
    domain = normalize_domain(request.domain)
    if not helper_available():
        raise HTTPException(status_code=500, detail="privileged helper is not installed")
    if not command_available("nginx"):
        raise HTTPException(status_code=400, detail="nginx is not installed")
    if not command_available("certbot"):
        raise HTTPException(status_code=400, detail="certbot is not installed")
    if not command_available("systemctl"):
        raise HTTPException(status_code=400, detail="systemctl is not available")

    config_values = persisted_config_values()
    previous_state = load_access_state()
    previous_domain = previous_state.get("domain")
    previous_site_content = read_nginx_site_content(domain)

    try:
        SETTINGS.state_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to prepare config paths: {exc}") from exc

    write_nginx_site(domain, SETTINGS.port)

    try:
        run_privileged_helper(["validate-nginx"], "validate nginx config")
        run_privileged_helper(
            ["enable-nginx"],
            "enable nginx",
        )
        run_privileged_helper(
            ["reload-nginx"],
            "reload nginx",
        )
        run_privileged_helper(
            ["issue-cert", domain, config_values.get("CERTBOT_EMAIL") or SETTINGS.certbot_email or ""],
            "issue tls certificate",
            timeout_seconds=CERTBOT_TIMEOUT_SECONDS,
        )
    except HTTPException:
        if previous_site_content is None:
            remove_nginx_site(domain)
        else:
            restore_nginx_site(domain, previous_site_content)
        try:
            run_privileged_helper(["validate-nginx"], "validate nginx rollback")
            run_privileged_helper(
                ["reload-nginx"],
                "reload nginx rollback",
            )
        except HTTPException:
            pass
        raise

    if previous_domain and previous_domain != domain:
        remove_nginx_site(str(previous_domain))
        try:
            run_privileged_helper(["validate-nginx"], "validate nginx cleanup")
            run_privileged_helper(
                ["reload-nginx"],
                "reload nginx cleanup",
            )
        except HTTPException:
            pass

    config_values["HOST"] = "127.0.0.1"
    config_values["PORT"] = str(SETTINGS.port)
    try:
        save_config_values(config_values)
        save_access_state(
            {
                "domain": domain,
                "public_url": f"https://{domain}",
                "https_enabled": True,
                "configured_at": utc_now(),
            }
        )
    except (OSError, sqlite3.Error) as exc:
        raise HTTPException(status_code=500, detail=f"failed to persist access config: {exc}") from exc

    restart_scheduled = False
    if config_values.get("HOST") != SETTINGS.host or int(config_values.get("PORT", SETTINGS.port)) != SETTINGS.port:
        restart_scheduled = schedule_service_restart(
            SETTINGS.agent_service_name,
            allow_restart=env_flag(
                config_values.get("ALLOW_SELF_RESTART"),
                default=SETTINGS.allow_self_restart,
            ),
        )

    return DomainSetupResponse(
        message="domain configured through nginx; agent will switch to local-only access after restart",
        public_url=f"https://{domain}",
        desired_bind_host=config_values["HOST"],
        https_enabled=True,
        restart_scheduled=restart_scheduled,
    )
