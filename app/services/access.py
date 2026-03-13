from __future__ import annotations

import json
import shlex
import subprocess
from pathlib import Path

from fastapi import HTTPException

from app.core.settings import (
    ACCESS_STATE_FILE,
    DOMAIN_PATTERN,
    SETTINGS,
    normalize_resource_sample_interval,
)
from app.models import (
    AccessStatus,
    ConfigResponse,
    ConfigUpdateRequest,
    ConfigUpdateResponse,
    DomainSetupRequest,
    DomainSetupResponse,
)
from app.services.common import (
    command_available,
    env_flag,
    is_public_bind,
    normalize_existing_directory,
    runtime_restart_needed,
    utc_now,
)


def default_env_values() -> dict[str, str]:
    return {
        "HOST": SETTINGS.host,
        "PORT": str(SETTINGS.port),
        "AGENT_NAME": SETTINGS.agent_name,
        "AGENT_ROOT": str(SETTINGS.root_path),
        "AGENT_TOKEN": SETTINGS.auth_token or "",
        "RESOURCE_SAMPLE_INTERVAL": str(SETTINGS.sample_interval_seconds),
        "ENV_FILE_PATH": str(SETTINGS.env_file_path),
        "STATE_DIR": str(SETTINGS.state_dir),
        "NGINX_SITES_AVAILABLE_DIR": str(SETTINGS.nginx_sites_available_dir),
        "NGINX_SITES_ENABLED_DIR": str(SETTINGS.nginx_sites_enabled_dir),
        "AGENT_SERVICE_NAME": SETTINGS.agent_service_name or "",
        "NGINX_SERVICE_NAME": SETTINGS.nginx_service_name or "",
        "CERTBOT_EMAIL": SETTINGS.certbot_email or "",
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
        "RESOURCE_SAMPLE_INTERVAL",
        "ENV_FILE_PATH",
        "STATE_DIR",
        "NGINX_SITES_AVAILABLE_DIR",
        "NGINX_SITES_ENABLED_DIR",
        "AGENT_SERVICE_NAME",
        "NGINX_SERVICE_NAME",
        "CERTBOT_EMAIL",
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


def load_access_state() -> dict[str, object]:
    state_path = access_state_path()
    if not state_path.exists():
        return {}
    try:
        return json.loads(state_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_access_state(payload: dict[str, object]) -> None:
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


def site_slug(domain: str) -> str:
    return domain.replace(".", "-")


def nginx_site_paths(domain: str) -> tuple[Path, Path]:
    file_name = f"files-agent-{site_slug(domain)}.conf"
    return (
        SETTINGS.nginx_sites_available_dir / file_name,
        SETTINGS.nginx_sites_enabled_dir / file_name,
    )


def render_nginx_site(domain: str, upstream_port: int) -> str:
    return (
        "server {\n"
        "    listen 80;\n"
        "    listen [::]:80;\n"
        f"    server_name {domain};\n\n"
        "    client_max_body_size 2g;\n\n"
        "    location / {\n"
        f"        proxy_pass http://127.0.0.1:{upstream_port};\n"
        "        proxy_http_version 1.1;\n"
        "        proxy_set_header Host $host;\n"
        "        proxy_set_header X-Real-IP $remote_addr;\n"
        "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
        "        proxy_set_header X-Forwarded-Proto $scheme;\n"
        "        proxy_set_header Upgrade $http_upgrade;\n"
        '        proxy_set_header Connection "upgrade";\n'
        "    }\n"
        "}\n"
    )


def certbot_args(domain: str, email: str | None) -> list[str]:
    command = [
        "certbot",
        "--nginx",
        "-d",
        domain,
        "--non-interactive",
        "--agree-tos",
        "--redirect",
        "--keep-until-expiring",
    ]
    if email:
        command.extend(["-m", email])
    else:
        command.append("--register-unsafely-without-email")
    return command


def tls_ready_for(domain: str | None, state: dict[str, object]) -> bool:
    if not domain:
        return False

    letsencrypt_cert = Path("/etc/letsencrypt/live") / domain / "fullchain.pem"
    if letsencrypt_cert.exists():
        return True
    return bool(state.get("https_enabled"))


def remove_nginx_site(domain: str) -> None:
    site_path, enabled_path = nginx_site_paths(domain)
    enabled_path.unlink(missing_ok=True)
    site_path.unlink(missing_ok=True)


def schedule_service_restart(service_name: str | None, *, allow_restart: bool | None = None) -> bool:
    if allow_restart is None:
        allow_restart = SETTINGS.allow_self_restart
    if not allow_restart or not service_name or not command_available("systemctl"):
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
    https_enabled = tls_ready_for(domain, state)
    public_url = f"https://{domain}" if domain and https_enabled else (f"http://{domain}" if domain else None)

    return AccessStatus(
        current_bind_host=SETTINGS.host,
        current_bind_port=SETTINGS.port,
        desired_bind_host=desired_host,
        desired_bind_port=desired_port,
        public_ip_access_enabled=is_public_bind(desired_host),
        domain=domain,
        public_url=public_url,
        nginx_available=command_available("nginx"),
        nginx_running=service_is_active(env_values.get("NGINX_SERVICE_NAME") or SETTINGS.nginx_service_name),
        certbot_available=command_available("certbot"),
        https_enabled=https_enabled,
        token_configured=bool(env_values.get("AGENT_TOKEN")),
        restart_pending=runtime_restart_needed(env_values),
    )


def build_config_response() -> ConfigResponse:
    env_values = {**default_env_values(), **read_env_file(SETTINGS.env_file_path)}
    desired_host = env_values.get("HOST", SETTINGS.host)
    desired_port = int(env_values.get("PORT", SETTINGS.port))
    desired_sample_interval = normalize_resource_sample_interval(
        env_values.get("RESOURCE_SAMPLE_INTERVAL"),
        fallback=SETTINGS.sample_interval_seconds,
    )
    public_domain = env_values.get("PUBLIC_DOMAIN") or load_access_state().get("domain") or None
    return ConfigResponse(
        agent_name=env_values.get("AGENT_NAME", SETTINGS.agent_name),
        agent_root=env_values.get("AGENT_ROOT", str(SETTINGS.root_path)),
        port=desired_port,
        resource_sample_interval=desired_sample_interval,
        allow_public_ip=is_public_bind(desired_host),
        certbot_email=env_values.get("CERTBOT_EMAIL") or None,
        allow_self_restart=env_flag(
            env_values.get("ALLOW_SELF_RESTART"),
            default=SETTINGS.allow_self_restart,
        ),
        public_domain=str(public_domain) if public_domain else None,
        token_configured=bool(env_values.get("AGENT_TOKEN")),
        auth_enabled=bool(SETTINGS.auth_token),
        current_bind_host=SETTINGS.host,
        current_bind_port=SETTINGS.port,
        desired_bind_host=desired_host,
        desired_bind_port=desired_port,
        restart_pending=runtime_restart_needed(env_values),
    )


def update_config(request: ConfigUpdateRequest) -> ConfigUpdateResponse:
    env_values = {**default_env_values(), **read_env_file(SETTINGS.env_file_path)}
    agent_name = request.agent_name.strip()
    if not agent_name:
        raise HTTPException(status_code=400, detail="agent name is required")

    agent_root = normalize_existing_directory(request.agent_root)
    certbot_email = (request.certbot_email or "").strip()
    allow_public_ip = bool(request.allow_public_ip)
    allow_self_restart = bool(request.allow_self_restart)
    next_token = (request.agent_token or "").strip()

    env_values["AGENT_NAME"] = agent_name
    env_values["AGENT_ROOT"] = str(agent_root)
    env_values["PORT"] = str(request.port)
    env_values["HOST"] = "0.0.0.0" if allow_public_ip else "127.0.0.1"
    env_values["CERTBOT_EMAIL"] = certbot_email
    env_values["ALLOW_SELF_RESTART"] = "1" if allow_self_restart else "0"
    if next_token:
        env_values["AGENT_TOKEN"] = next_token

    try:
        write_env_file(SETTINGS.env_file_path, env_values)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to persist config: {exc}") from exc

    restart_required = runtime_restart_needed(env_values)
    restart_scheduled = False
    if restart_required:
        restart_scheduled = schedule_service_restart(
            env_values.get("AGENT_SERVICE_NAME") or SETTINGS.agent_service_name,
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


def configure_domain_access(request: DomainSetupRequest) -> DomainSetupResponse:
    domain = normalize_domain(request.domain)
    if not command_available("nginx"):
        raise HTTPException(status_code=400, detail="nginx is not installed")
    if not command_available("certbot"):
        raise HTTPException(status_code=400, detail="certbot is not installed")
    if not command_available("systemctl"):
        raise HTTPException(status_code=400, detail="systemctl is not available")

    env_values = {**default_env_values(), **read_env_file(SETTINGS.env_file_path)}
    previous_state = load_access_state()
    previous_domain = previous_state.get("domain")
    site_path, enabled_path = nginx_site_paths(domain)
    previous_site_content = site_path.read_text(encoding="utf-8") if site_path.exists() else None

    try:
        SETTINGS.state_dir.mkdir(parents=True, exist_ok=True)
        SETTINGS.nginx_sites_available_dir.mkdir(parents=True, exist_ok=True)
        SETTINGS.nginx_sites_enabled_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to prepare config paths: {exc}") from exc

    try:
        site_path.write_text(render_nginx_site(domain, SETTINGS.port), encoding="utf-8")
        if not enabled_path.exists() and not enabled_path.is_symlink():
            enabled_path.symlink_to(site_path)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to write nginx config: {exc}") from exc

    try:
        run_command(["nginx", "-t"], "validate nginx config")
        run_command(
            ["systemctl", "enable", "--now", env_values.get("NGINX_SERVICE_NAME") or SETTINGS.nginx_service_name or "nginx"],
            "enable nginx",
        )
        run_command(
            ["systemctl", "reload", env_values.get("NGINX_SERVICE_NAME") or SETTINGS.nginx_service_name or "nginx"],
            "reload nginx",
        )
        run_command(
            certbot_args(domain, env_values.get("CERTBOT_EMAIL") or SETTINGS.certbot_email),
            "issue tls certificate",
        )
    except HTTPException:
        if previous_site_content is None:
            remove_nginx_site(domain)
        else:
            site_path.write_text(previous_site_content, encoding="utf-8")
            if not enabled_path.exists() and not enabled_path.is_symlink():
                enabled_path.symlink_to(site_path)
        try:
            run_command(["nginx", "-t"], "validate nginx rollback")
            run_command(
                ["systemctl", "reload", env_values.get("NGINX_SERVICE_NAME") or SETTINGS.nginx_service_name or "nginx"],
                "reload nginx rollback",
            )
        except HTTPException:
            pass
        raise

    if previous_domain and previous_domain != domain:
        remove_nginx_site(str(previous_domain))
        try:
            run_command(["nginx", "-t"], "validate nginx cleanup")
            run_command(
                ["systemctl", "reload", env_values.get("NGINX_SERVICE_NAME") or SETTINGS.nginx_service_name or "nginx"],
                "reload nginx cleanup",
            )
        except HTTPException:
            pass

    env_values["HOST"] = "127.0.0.1"
    env_values["PORT"] = str(SETTINGS.port)
    env_values["PUBLIC_DOMAIN"] = domain
    try:
        write_env_file(SETTINGS.env_file_path, env_values)
        save_access_state(
            {
                "domain": domain,
                "public_url": f"https://{domain}",
                "https_enabled": True,
                "configured_at": utc_now(),
            }
        )
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"failed to persist access config: {exc}") from exc

    restart_scheduled = False
    if env_values.get("HOST") != SETTINGS.host or int(env_values.get("PORT", SETTINGS.port)) != SETTINGS.port:
        restart_scheduled = schedule_service_restart(
            env_values.get("AGENT_SERVICE_NAME") or SETTINGS.agent_service_name,
            allow_restart=env_flag(
                env_values.get("ALLOW_SELF_RESTART"),
                default=SETTINGS.allow_self_restart,
            ),
        )

    return DomainSetupResponse(
        message="domain configured through nginx; agent will switch to local-only access after restart",
        public_url=f"https://{domain}",
        desired_bind_host=env_values["HOST"],
        https_enabled=True,
        restart_scheduled=restart_scheduled,
    )
