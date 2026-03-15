#!/usr/bin/env bash

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-files-agent}"
ENV_FILE="${ENV_FILE:-/etc/files-agent/files-agent.env}"
STATE_DIR="${STATE_DIR:-/var/lib/files-agent}"
DB_PATH="${DB_PATH:-}"
DEFAULT_LOG_LINES="${DEFAULT_LOG_LINES:-80}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALLED_PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UNINSTALL_SCRIPT="$SCRIPT_DIR/uninstall_agent.sh"

read_env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d "=" -f 2- || true
}

service_role() {
  local role
  role="$(read_env_value FILE_PANEL_ROLE)"
  if [[ -z "$role" ]]; then
    role="manager"
  fi
  printf '%s\n' "$role"
}

database_path() {
  if [[ -n "$DB_PATH" ]]; then
    printf '%s\n' "$DB_PATH"
    return
  fi

  local from_env
  from_env="$(read_env_value DATABASE_PATH)"
  if [[ -n "$from_env" ]]; then
    printf '%s\n' "$from_env"
    return
  fi

  printf '%s\n' "${STATE_DIR}/file-panel.db"
}

db_query() {
  local sql="$1"
  local path
  path="$(database_path)"
  if [[ ! -f "$path" ]]; then
    return 0
  fi
  sqlite3 -batch -noheader "$path" "$sql" 2>/dev/null || true
}

read_config_value() {
  local key="$1"
  local value
  value="$(db_query "SELECT value FROM config WHERE key='${key}' LIMIT 1;")"
  if [[ -n "$value" ]]; then
    printf '%s\n' "$value"
    return
  fi
  read_env_value "$key"
}

read_access_value() {
  local key="$1"
  db_query "SELECT ${key} FROM access_state WHERE singleton_id=1 LIMIT 1;"
}

server_ip() {
  hostname -I | awk '{print $1}'
}

wireguard_ip() {
  if ! command -v ip >/dev/null 2>&1; then
    return 0
  fi
  ip -4 -o addr show wg0 2>/dev/null | awk '{print $4}' | cut -d/ -f1
}

bind_host() {
  local host
  host="$(read_config_value HOST)"
  if [[ -z "$host" ]]; then
    host="127.0.0.1"
  fi
  printf '%s\n' "$host"
}

bind_port() {
  local port
  port="$(read_config_value PORT)"
  if [[ -z "$port" ]]; then
    port="3000"
  fi
  printf '%s\n' "$port"
}

log() {
  printf '\n==> %s\n' "$1"
}

is_project_dir() {
  local candidate="$1"
  [[ -n "$candidate" ]] \
    && [[ -d "$candidate/app" ]] \
    && [[ -d "$candidate/static" ]] \
    && [[ -d "$candidate/scripts" ]] \
    && [[ -f "$candidate/requirements.txt" ]]
}

resolve_source_project_dir() {
  local candidate=""

  if [[ -n "${FILE_PANEL_SOURCE_DIR:-}" ]] && is_project_dir "${FILE_PANEL_SOURCE_DIR}"; then
    candidate="${FILE_PANEL_SOURCE_DIR}"
  elif is_project_dir "$PWD"; then
    candidate="$PWD"
  else
    candidate="$INSTALLED_PROJECT_DIR"
  fi

  (
    cd "$candidate"
    pwd
  )
}

resolve_install_script() {
  local role candidate
  role="$(service_role)"
  if [[ "$role" == "agent" ]]; then
    candidate="$SCRIPT_DIR/install_agent_only.sh"
  else
    candidate="$SCRIPT_DIR/install_manager.sh"
  fi

  if [[ -f "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return
  fi
  printf '%s\n' "$SCRIPT_DIR/install_agent.sh"
}

ensure_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    return
  fi
  exec sudo bash "$0" "$@"
}

show_access_info() {
  local role host port domain token ip db wg_ip
  role="$(service_role)"
  host="$(bind_host)"
  port="$(bind_port)"
  domain="$(read_access_value domain)"
  token="$(read_config_value AGENT_TOKEN)"
  ip="$(server_ip)"
  db="$(database_path)"
  wg_ip="$(wireguard_ip)"

  log "Access Info"
  echo "Role: ${role}"

  if [[ "$role" == "manager" ]]; then
    if [[ -n "$domain" ]]; then
      echo "Manager URL: https://${domain}"
    elif [[ "$host" == "127.0.0.1" || "$host" == "::1" || "$host" == "localhost" ]]; then
      echo "Manager URL: http://127.0.0.1:${port}"
    else
      echo "Manager URL: http://${ip}:${port}"
    fi
  else
    if [[ "$host" == "127.0.0.1" || "$host" == "::1" || "$host" == "localhost" ]]; then
      echo "Agent API: http://127.0.0.1:${port}"
    else
      echo "Agent API: http://${ip}:${port}"
    fi
    echo "Browser UI: disabled on agent-only nodes"
  fi

  if [[ -n "$wg_ip" ]]; then
    echo "WireGuard IP: ${wg_ip}"
    echo "WireGuard URL: http://${wg_ip}:${port}"
  fi
  if [[ -n "$token" ]]; then
    echo "AGENT_TOKEN: ${token}"
  fi
  echo "SQLite: ${db}"
}

run_install_with_script() {
  local install_system_packages="$1"
  local sync_python_deps="$2"
  local install_script="$3"
  local source_project_dir
  source_project_dir="$(resolve_source_project_dir)"

  log "Sync File Panel"
  if [[ "$source_project_dir" != "$INSTALLED_PROJECT_DIR" ]]; then
    echo "Source directory: ${source_project_dir}"
  fi

  INSTALL_SYSTEM_PACKAGES="$install_system_packages" \
  SYNC_PYTHON_DEPS="$sync_python_deps" \
  PROJECT_DIR_OVERRIDE="$source_project_dir" \
  bash "$install_script"
}

run_install() {
  local install_system_packages="$1"
  local sync_python_deps="$2"
  local install_script
  install_script="$(resolve_install_script)"
  run_install_with_script "$install_system_packages" "$sync_python_deps" "$install_script"
}

start_agent() {
  log "Start ${SERVICE_NAME}"
  systemctl start "$SERVICE_NAME"
}

restart_agent() {
  log "Restart ${SERVICE_NAME}"
  systemctl restart "$SERVICE_NAME"
}

stop_agent() {
  log "Stop ${SERVICE_NAME}"
  systemctl stop "$SERVICE_NAME"
}

status_agent() {
  log "Service Status"
  systemctl status "$SERVICE_NAME" --no-pager --lines=30 || true
}

logs_agent() {
  local lines="${1:-$DEFAULT_LOG_LINES}"
  log "Recent Logs"
  journalctl -u "$SERVICE_NAME" -n "$lines" --no-pager
}

full_install() {
  run_install 1 1
  restart_agent
  status_agent
  show_access_info
}

redeploy() {
  run_install 0 1
  restart_agent
  status_agent
  show_access_info
}

quick_reload() {
  run_install 0 0
  restart_agent
  status_agent
  show_access_info
}

grant_access() {
  local target="${1:-}"
  if [[ -z "$target" ]]; then
    target="$(read_config_value AGENT_ROOT)"
  fi
  if [[ -z "$target" ]]; then
    echo "Please provide a directory to grant." >&2
    exit 1
  fi

  log "Grant Access To filepanel"
  echo "Target: ${target}"
  if [[ ! -x /usr/local/libexec/file-panel/file-panel-helper.sh ]]; then
    echo "Privileged helper is not installed." >&2
    exit 1
  fi
  /usr/local/libexec/file-panel/file-panel-helper.sh grant-path-access "$target"
  echo "Access granted to filepanel."
}

revoke_access() {
  local target="${1:-}"
  if [[ -z "$target" ]]; then
    echo "Please provide a directory to revoke." >&2
    exit 1
  fi

  log "Revoke Access From filepanel"
  echo "Target: ${target}"
  if [[ ! -x /usr/local/libexec/file-panel/file-panel-helper.sh ]]; then
    echo "Privileged helper is not installed." >&2
    exit 1
  fi
  /usr/local/libexec/file-panel/file-panel-helper.sh revoke-path-access "$target"
  echo "ACL removed from filepanel."
}

uninstall_panel() {
  log "Uninstall File Panel"
  bash "$UNINSTALL_SCRIPT"
}

show_help() {
  cat <<'EOF'
Usage:
  file-panel <command>

Commands:
  start         Start the installed service
  restart       Restart the installed service
  stop          Stop the installed service
  status        Show service status
  logs [n]      Show the last n service log lines (default: 80)
  info          Show role, URL, WireGuard IP and AGENT_TOKEN
  grant-access  Grant file access to filepanel for a directory; defaults to AGENT_ROOT
  revoke-access Revoke filepanel ACL access from a directory
  uninstall     Uninstall File Panel and remove SQLite data
  full-install  Install dependencies, sync code and restart the current role
  redeploy      Sync code and Python dependencies, then restart the current role
  quick         Sync code only, then restart the current role
  help          Show this message

Role-specific install scripts:
  sudo bash scripts/install_manager.sh
  sudo bash scripts/install_agent_only.sh
EOF
}

command="${1:-status}"
shift || true

case "$command" in
  help|-h|--help)
    show_help
    ;;
  full-install)
    ensure_root "$command" "$@"
    full_install
    ;;
  redeploy)
    ensure_root "$command" "$@"
    redeploy
    ;;
  quick)
    ensure_root "$command" "$@"
    quick_reload
    ;;
  start)
    ensure_root "$command" "$@"
    start_agent
    status_agent
    show_access_info
    ;;
  restart)
    ensure_root "$command" "$@"
    restart_agent
    status_agent
    show_access_info
    ;;
  stop)
    ensure_root "$command" "$@"
    stop_agent
    status_agent
    ;;
  status)
    ensure_root "$command" "$@"
    status_agent
    ;;
  logs)
    ensure_root "$command" "$@"
    logs_agent "${1:-$DEFAULT_LOG_LINES}"
    ;;
  info)
    ensure_root "$command" "$@"
    show_access_info
    ;;
  grant-access)
    ensure_root "$command" "$@"
    grant_access "${1:-}"
    ;;
  revoke-access)
    ensure_root "$command" "$@"
    revoke_access "${1:-}"
    ;;
  uninstall)
    ensure_root "$command" "$@"
    uninstall_panel
    ;;
  *)
    echo "Unknown command: $command" >&2
    show_help >&2
    exit 1
    ;;
esac
